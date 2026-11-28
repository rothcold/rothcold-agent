import Foundation

actor NativeAPI {
    nonisolated let selection: ServerSelection
    private var socket: NoiseSocket?
    private var link: WireLink?
    private var occupied = false

    init(selection: ServerSelection) { self.selection = selection }

    var isConnected: Bool { link != nil }

    func connect() async throws {
        guard !occupied, socket == nil else { throw APIError.connectionInUse }
        occupied = true
        defer { occupied = false }
        let socket = try NoiseSocket(endpoint: selection.endpoint())
        self.socket = socket
        do {
            let start = try startNativeHandshake(pin: selection.pin)
            try await socket.write(start.first, timeout: 5)
            let reply = try await socket.read(timeout: 5)
            let link = WireLink(socket: socket, codec: try start.handshake.verify(reply: reply))
            let status: ServiceStatus = try await link.call(.status, .status)
            guard status.service == "rothcold-agent", status.version == 1 else { throw APIError.incompatible }
            try Task.checkCancellation()
            self.link = link
        } catch {
            close()
            throw error
        }
    }

    func close() {
        socket?.close()
        socket = nil
        link = nil
    }

    func login(owner: String, name: String) async throws -> LoginReceipt {
        try await transaction { link in
            let receipt: LoginReceipt = try await link.call(.login(owner: owner, name: name), .nativeLogin)
            guard Data(receipt.pin) == selection.pin, receipt.credential.count == 32 else { throw APIError.incompatible }
            return receipt
        }
    }

    func restore(_ credential: Data) async throws -> Device {
        guard credential.count == 32 else { throw APIError.incompatible }
        let receipt: DeviceReceipt = try await call(.resume(pin: selection.pin, credential: credential), .device)
        return receipt.device
    }

    func call<T: Decodable & Sendable>(_ request: NativeRequest, _ kind: OutcomeKind) async throws -> T {
        try await transaction { try await $0.call(request, kind) }
    }

    func perform(_ request: NativeRequest, _ kind: OutcomeKind = .ok) async throws {
        let _: EmptyResult = try await call(request, kind)
    }

    func validateMediaAccess() async throws {
        let _: DeviceReceipt = try await transaction { try await $0.call(.me, .device, timeout: 3) }
    }

    func directory() async throws -> WorkspaceDirectory {
        try await transaction { link in
            let categories: [DirectoryCategory] = try await link.pages(NativeRequest.categories, .categories)
            let threads: [DirectoryThread] = try await link.pages(NativeRequest.threads, .threads)
            return WorkspaceDirectory(categories: categories, threads: threads)
        }
    }

    func history(chat: String) async throws -> [Turn] {
        try await transaction { try await $0.pages({ .history(chat: chat, after: $0) }, .history) }
    }

    func updates(chat: String, turn: String) async throws -> [TurnUpdate] {
        try await transaction { try await $0.pages({ .turnUpdates(chat: chat, turn: turn, after: $0) }, .turnUpdates) }
    }

    func inbox() async throws -> [InboxEntry] {
        try await transaction { try await $0.pages(NativeRequest.inbox, .inbox) }
    }

    func devices() async throws -> [Device] {
        try await transaction { link in
            try await link.collect { after in
                let result: DevicePage = try await link.call(.devices(after: after), .devices)
                return result.page
            }
        }
    }

    func backends() async throws -> [BackendProfile] {
        try await transaction { try await $0.pages(NativeRequest.profileBackends, .profileBackends) }
    }

    func upload(_ url: URL, purpose: UploadPurpose, mime: String?) async throws -> NativeAttachment {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let input = try AttachmentInput(url: url, purpose: purpose)
        defer { try? input.handle.close() }
        return try await transaction { try await $0.upload(input, purpose: purpose, mime: mime) }
    }

    func download(id: String) async throws -> DownloadedFile {
        try await transaction { try await $0.download(id: id) }
    }

    private func transaction<T: Sendable>(_ run: (WireLink) async throws -> T) async throws -> T {
        guard !occupied else { throw APIError.connectionInUse }
        guard let link else { throw APIError.disconnected }
        occupied = true
        defer { occupied = false }
        do {
            try Task.checkCancellation()
            return try await run(link)
        } catch APIError.rejected(let code, let message) where code != .unauthorized {
            throw APIError.rejected(code, message)
        } catch {
            close()
            throw error
        }
    }
}

struct WorkspaceDirectory: Sendable {
    let categories: [DirectoryCategory]
    let threads: [DirectoryThread]
    let active: [ActiveCategory]

    init(categories: [DirectoryCategory], threads: [DirectoryThread]) {
        self.categories = categories
        self.threads = threads
        active = activeDirectory(categories: categories, threads: threads)
    }

    func isArchived(_ thread: DirectoryThread) -> Bool {
        thread.archived || categories.contains { $0.id == thread.channel && $0.archived }
    }
}

struct WireLink: Sendable {
    let socket: NoiseSocket
    let codec: NativeCodec

    func send(_ request: NativeRequest, timeout: TimeInterval = 30) async throws {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        try await socket.write(codec.request(json: encoder.encode(request)), timeout: timeout)
    }

    func receive(timeout: TimeInterval = 30) async throws -> NativeReply {
        let reply = try codec.response(packet: await socket.read(timeout: timeout))
        if case .rejected(let code, let message) = reply { throw APIError.rejected(code, message) }
        return reply
    }

    func call<T: Decodable & Sendable>(_ request: NativeRequest, _ kind: OutcomeKind,
                                      timeout: TimeInterval = 30) async throws -> T {
        try await send(request, timeout: timeout)
        while true {
            switch try await receive(timeout: timeout) {
            case .resultPending: continue
            case .outcome(let json):
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                let result = try decoder.decode(Outcome<T>.self, from: json)
                guard result.type == kind else { throw APIError.incompatible }
                return result.payload
            default: throw APIError.incompatible
            }
        }
    }

    func pages<T: Decodable & Sendable>(_ request: (String?) -> NativeRequest, _ kind: OutcomeKind) async throws -> [T] {
        try await collect { after in
            let result: Paged<T> = try await call(request(after), kind)
            return result.page
        }
    }

    func collect<T: Decodable & Sendable>(_ fetch: (String?) async throws -> Page<T>) async throws -> [T] {
        var after: String?
        var visited = Set<String>()
        var items: [T] = []
        repeat {
            let page = try await fetch(after)
            items += page.items
            after = page.next
            if let after, !visited.insert(after).inserted { throw APIError.incompatible }
        } while after != nil
        return items
    }
}
