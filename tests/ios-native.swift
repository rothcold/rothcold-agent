import CryptoKit
import Foundation

private struct CheckFailed: Error, CustomStringConvertible { let description: String }

@main struct IOSNoiseHarness {
    static func main() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["IOS_NOISE_TEST_ADDRESS"], let pin = env["IOS_NOISE_TEST_PIN"],
              let owner = env["IOS_NOISE_TEST_OWNER"], let root = env["IOS_NOISE_TEST_ARTIFACTS"] else {
            throw CheckFailed(description: "Run against the disposable iOS fixture.")
        }
        let selection = try ServerSelection(address: address, pin: pin)
        let artifacts = URL(fileURLWithPath: root, isDirectory: true)
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "download" {
            let api = try await connected(selection)
            _ = try await api.login(owner: owner, name: "Disposable cross-client verifier")
            let file = try await api.download(id: CommandLine.arguments[2])
            print("\(file.attachment.size) \(try sha(Data(contentsOf: file.url)))")
            try await api.perform(.logout)
            await api.close()
            return
        }
        if CommandLine.arguments.count == 4 {
            let api = try await connected(selection)
            _ = try await api.login(owner: owner, name: "Disposable business verifier")
            let chat = CommandLine.arguments[2], turn = CommandLine.arguments[3]
            switch CommandLine.arguments[1] {
            case "approve": try await approve(api, chat: chat, turn: turn)
            case "recover": try await recover(api, chat: chat, turn: turn)
            default: throw CheckFailed(description: "Unknown harness mode")
            }
            try await api.perform(.logout)
            await api.close()
            return
        }
        try await run(selection, owner: owner, artifacts: artifacts)
    }

    private static func run(_ selection: ServerSelection, owner: String, artifacts: URL) async throws {
        try await identity(selection, owner: owner)
        let primary = try await connected(selection)
        let receipt = try await primary.login(owner: owner, name: "Native harness")
        try await workspace(primary, selection: selection, credential: Data(receipt.credential))
        let test = try await files(primary, artifacts: artifacts)
        try await cancel(selection, credential: Data(receipt.credential), artifacts: artifacts)
        let reader = try await connected(selection)
        let second = try await reader.login(owner: owner, name: "Second native device")
        let file = try await reader.download(id: test.attachment)
        try verify(try Data(contentsOf: file.url) == Data(contentsOf: artifacts.appending(path: test.filename)), "independent device byte equality")
        file.discard()
        let revoked: Revocation = try await primary.call(.revokeDevice(id: second.device.id), .revoked)
        try verify(!revoked.current, "revoking second device is not current")
        try await denied { _ = try await reader.download(id: test.attachment) }
        let revokedReader = try await connected(selection)
        try await denied { _ = try await revokedReader.restore(Data(second.credential)) }
        try await primary.perform(.logout)
        await primary.close()
        let loggedOut = try await connected(selection)
        try await denied { _ = try await loggedOut.restore(Data(receipt.credential)) }
        try JSONEncoder().encode(test).write(to: artifacts.appending(path: "cross-client-file.json"))
        print("Production Swift/UniFFI Noise: pin, unauthenticated denial, login, restore, revocation, directory, idempotency, paging, files/avatar, cancellation passed.")
    }

    private static func identity(_ selection: ServerSelection, owner: String) async throws {
        for input in ["https://127.0.0.1", "localhost", "8.8.8.8", "192.168.1.2:0", "[2001::1]", "127.0.0.1:8768/path"] {
            try verify((try? ServerSelection(address: input, pin: selection.pinHex)) == nil, "reject non-private endpoint: \(input)")
        }
        try verify(try ServerSelection(address: "[::1]", pin: selection.pinHex).address == "[::1]:8768", "canonical IPv6 loopback")
        try verify(try ServerSelection(address: "192.168.20.2", pin: selection.pinHex.uppercased()).address == "192.168.20.2:8768", "canonical private address")
        let wrong = try ServerSelection(address: selection.address, pin: String(repeating: "5a", count: 32))
        try verify(wrong.keychainAccount != selection.keychainAccount, "pin-separated keychain scope")
        let wrongAPI = NativeAPI(selection: wrong)
        do { try await wrongAPI.connect(); throw CheckFailed(description: "wrong pin accepted") }
        catch APIError.disconnected {} catch NoiseFailure.Identity {}
        do { _ = try await wrongAPI.login(owner: owner, name: "Do not enroll"); throw CheckFailed(description: "login after failed identity") }
        catch APIError.disconnected {}
        let unauthenticated = try await connected(selection)
        try await denied { _ = try await unauthenticated.directory() }
    }

    private static func workspace(_ primary: NativeAPI, selection: ServerSelection, credential: Data) async throws {
        let fresh = try await connected(selection)
        let device = try await fresh.restore(credential)
        try verify(device.name == "Native harness", "restore uses same device")
        await fresh.close()
        let general = try await primary.directory()
        try verify(general.active.first?.id == "general", "Rust directory read")
        for index in 0..<18 {
            try await primary.perform(.createCategory(name: "Paging \(index)"), .categoryCreated)
        }
        let directory = try await primary.directory()
        try verify(directory.active.count == 19, "category pagination")
        guard let category = directory.categories.first(where: { $0.name == "Paging 17" }) else {
            throw CheckFailed(description: "created category missing")
        }
        let opening = WireMessage(id: uuid(), text: "hello from the native harness", attachments: [])
        let thread: CreatedThread = try await primary.call(.startThread(channel: category.id, message: opening), .threadStarted)
        let retry: CreatedThread = try await primary.call(.startThread(channel: category.id, message: opening), .threadStarted)
        try verify(thread.fresh && !retry.fresh && thread.id == retry.id, "stable start receipt retry")
        let reply = WireMessage(id: uuid(), text: "queued after original", attachments: [])
        let result: QueuedTurn = try await primary.call(.sendTurn(chat: thread.id, message: reply), .turnSent)
        try verify(result.id == reply.id && result.fresh, "reply enqueued")
        try await primary.perform(.renameThread(id: thread.id, title: "Keep stable thread ID"), .threadRenamed)
        try await primary.perform(.archiveCategory(id: category.id, archived: true), .archived)
        let archived = try await primary.directory()
        try verify(!archived.active.flatMap(\.threads).contains { $0.id == thread.id }, "effective archive filtering")
        let history = try await primary.history(chat: thread.id)
        try verify(history.map(\.id) == [opening.id, reply.id] && history.allSatisfy { $0.state == .queued }, "archived history and FIFO order")
        try await primary.perform(.archiveCategory(id: category.id, archived: false), .archived)
        try await primary.perform(.moveThread(id: thread.id, channel: "general"), .threadMoved)
        let moved = try await primary.directory()
        try verify(moved.active.first?.threads.contains { $0.id == thread.id && $0.title == "Keep stable thread ID" } == true, "stable move and rename")
    }

    private struct CrossClientFile: Encodable {
        let filename: String
        let attachment: String
        let thread: String
        let size: Int
        let sha256: String
    }

    private static func files(_ api: NativeAPI, artifacts: URL) async throws -> CrossClientFile {
        let payload = Data((0..<98_345).map { UInt8(truncatingIfNeeded: $0 * 73 + 19) })
        let source = artifacts.appending(path: "ios-cross-client.bin")
        try payload.write(to: source)
        let attachment = try await api.upload(source, purpose: .turn, mime: nil)
        try verify(attachment.size == payload.count && attachment.kind == "file", "four-record upload")
        let svg = artifacts.appending(path: "download-only.svg")
        try Data("<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"1\"/></svg>".utf8).write(to: svg)
        let unsafe = try await api.upload(svg, purpose: .turn, mime: "image/svg+xml")
        try verify(unsafe.kind == "file", "SVG not classified inline")
        let opening = WireMessage(id: uuid(), text: "", attachments: [attachment.id, unsafe.id])
        let thread: CreatedThread = try await api.call(.startThread(channel: "general", message: opening), .threadStarted)
        let history = try await api.history(chat: thread.id)
        try verify(history.first?.attachments.map(\.id) == opening.attachments, "attachment-only thread, exact IDs")
        let file = try await api.download(id: attachment.id)
        try verify(try Data(contentsOf: file.url) == payload, "complete download bytes")
        file.discard()
        try verify(!FileManager.default.fileExists(atPath: file.url.path), "temporary download discarded")
        try await avatar(api, artifacts: artifacts)
        return CrossClientFile(filename: source.lastPathComponent, attachment: attachment.id, thread: thread.id,
                               size: payload.count, sha256: sha(payload))
    }

    private static func avatar(_ api: NativeAPI, artifacts: URL) async throws {
        let url = artifacts.appending(path: "fixture-avatar.png")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
        try png.write(to: url)
        let uploaded = try await api.upload(url, purpose: .avatar, mime: "image/png")
        let receipt: ProfileReceipt = try await api.call(
            .updateProfile(owner: IdentityPatch(name: "Fixture Owner", avatar: .set(uploaded.id)), agent: nil), .profile
        )
        try verify(receipt.profile.owner.avatar == uploaded.id && uploaded.kind == "image", "profile avatar assigned")
        let file = try await api.download(id: uploaded.id)
        try verify(try Data(contentsOf: file.url) == png, "avatar exact bytes")
        file.discard()
    }

    private static func cancel(_ selection: ServerSelection, credential: Data, artifacts: URL) async throws {
        let api = try await connected(selection)
        _ = try await api.restore(credential)
        let source = artifacts.appending(path: "cancelled.bin")
        FileManager.default.createFile(atPath: source.path, contents: nil)
        let handle = try FileHandle(forWritingTo: source)
        try handle.truncate(atOffset: UploadPurpose.turn.limit)
        try handle.close()
        defer { try? FileManager.default.removeItem(at: source) }
        let task = Task { try await api.upload(source, purpose: .turn, mime: nil) }
        try await Task.sleep(for: .milliseconds(40))
        task.cancel()
        do { _ = try await task.value; throw CheckFailed(description: "canceled upload reported success") }
        catch is CancellationError {} catch APIError.disconnected {}
        try verify(await !api.isConnected, "cancel closes connection")
        let other = try await connected(selection)
        _ = try await other.restore(credential)
        _ = try await other.directory()
        await other.close()
    }

    private static func approve(_ api: NativeAPI, chat: String, turn: String) async throws {
        let updates = try await api.updates(chat: chat, turn: turn)
        try verify(updates.first { $0.id == "approval-a" }?.choices == [.once], "first prompt choice")
        try verify(updates.first { $0.id == "approval-b" }?.choices == [.deny], "second prompt choice")
        try await conflict { try await api.perform(.decideApproval(chat: chat, id: "approval-a", choice: .deny)) }
        try await api.perform(.decideApproval(chat: chat, id: "approval-b", choice: .deny))
        try await conflict { try await api.perform(.decideApproval(chat: chat, id: "approval-b", choice: .deny)) }
    }

    private static func recover(_ api: NativeAPI, chat: String, turn: String) async throws {
        let catalog: CatalogReceipt = try await api.call(.slashCatalog, .slashCatalog)
        try verify(catalog.catalog?.skills == ["synthetic-skill"], "typed isolated slash catalog")
        let history = try await api.history(chat: chat)
        try verify(history.map(\.state) == [.unknown, .queued], "interrupted turn blocks its queued reply")
        try await api.perform(.releaseTurn(chat: chat, id: turn))
        let released = try await api.history(chat: chat)
        try verify(released.map(\.state) == [.released, .queued], "explicit original-ID release")
    }

    private static func conflict(_ run: () async throws -> Void) async throws {
        do { try await run(); throw CheckFailed(description: "expected an application conflict") }
        catch APIError.rejected(.conflict, _) {}
    }

    private static func denied(_ run: () async throws -> Void) async throws {
        do { try await run(); throw CheckFailed(description: "request authenticated unexpectedly") }
        catch APIError.rejected(.unauthorized, _) {}
    }

    private static func connected(_ selection: ServerSelection) async throws -> NativeAPI {
        let api = NativeAPI(selection: selection)
        try await api.connect()
        return api
    }

    private static func verify(_ truth: Bool, _ detail: String) throws {
        if !truth { throw CheckFailed(description: detail) }
    }

    private static func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func uuid() -> String { UUID().uuidString.lowercased() }
}
