import Foundation
import Observation

@MainActor @Observable
final class Workspace {
    enum Screen { case connect, signIn, workspace, reconnect }
    enum Panel: Hashable { case directory, category(String), thread(String), inbox, settings }
    enum DraftScope: Hashable { case category(String), thread(String) }
    enum IdentityRole: String, Identifiable { case owner, agent; var id: Self { self } }

    struct Draft {
        var text = ""
        var attachments: [NativeAttachment] = []
        var approval: String?
        var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty }
    }

    private(set) var screen = Screen.connect
    private(set) var selection: ServerSelection?
    private(set) var panel = Panel.directory
    private(set) var busy = false
    private(set) var transferring = false
    private(set) var message: String?
    private(set) var directory: WorkspaceDirectory?
    private(set) var device: Device?
    private(set) var devices: [Device] = []
    private(set) var profile: Profile?
    private(set) var backends: [BackendProfile] = []
    private(set) var catalog: SlashCatalog?
    private(set) var inbox: [InboxEntry] = []
    private(set) var turns: [Turn] = []
    private(set) var updates: [String: [TurnUpdate]] = [:]
    private(set) var file: DownloadedFile?
    private(set) var replyTarget: String?
    private let store: any SessionStore
    private let preferences: UserDefaults
    private var api: NativeAPI?
    private var polling = false
    private var catalogExpiresAt: ContinuousClock.Instant?
    private var drafts: [DraftScope: Draft] = [:]
    private var pending: [DraftScope: WireMessage] = [:]
    private var threadBack = Panel.directory
    private var seen: Set<String> = []
    private var marked: Set<String> = []
    private var lastRefresh = ContinuousClock.now
    private var hadInitialSelection = false
    private var fileGeneration = 0
    private var nextFileAuthorization = ContinuousClock.now

    init(store: any SessionStore = SessionKeychain(), preferences: UserDefaults = .standard) {
        self.store = store
        self.preferences = preferences
    }

    var lastAddress: String { preferences.string(forKey: "lastNoiseEndpoint") ?? "" }
    var lastPin: String { preferences.string(forKey: "lastNoisePublicPin") ?? "" }

    func restoreSelection() async {
        guard !hadInitialSelection else { return }
        hadInitialSelection = true
        DownloadedFile.discardPreviousDownloads()
        if !lastAddress.isEmpty && !lastPin.isEmpty { await connect(address: lastAddress, pin: lastPin) }
    }

    func connect(address: String, pin: String) async {
        guard screen == .connect, !busy else { return }
        do { await establish(try ServerSelection(address: address, pin: pin)) }
        catch { report(error) }
    }

    func reconnect() async {
        guard screen == .reconnect, !busy, let selection else { return }
        await establish(selection)
    }

    private func establish(_ selection: ServerSelection) async {
        busy = true
        message = nil
        defer { busy = false }
        let api = NativeAPI(selection: selection)
        self.api = api
        self.selection = selection
        do {
            try await api.connect()
            preferences.set(selection.address, forKey: "lastNoiseEndpoint")
            preferences.set(selection.pinHex, forKey: "lastNoisePublicPin")
            guard let credential = try store.read(for: selection) else {
                clearWorkspace(keepDrafts: false)
                screen = .signIn
                return
            }
            do { device = try await api.restore(credential) }
            catch APIError.rejected(.unauthorized, _) {
                await clearAuthorization(api, next: .signIn)
                if message == nil { message = "This device session is no longer valid. Sign in again." }
                return
            }
            screen = .workspace
            try await refreshWorkspace(api)
        } catch { await handle(error, api: api) }
    }

    func signIn(owner: String, name: String) async {
        guard screen == .signIn, !busy, let api else { return }
        busy = true
        message = nil
        defer { busy = false }
        do {
            if !(await api.isConnected) { try await api.connect() }
            let receipt = try await api.login(owner: owner, name: name)
            do { try store.save(Data(receipt.credential), for: api.selection) }
            catch {
                try? await api.perform(.logout)
                await api.close()
                screen = .reconnect
                throw APIError.keychainWrite
            }
            device = receipt.device
            screen = .workspace
            try await refreshWorkspace(api)
        } catch { await handle(error, api: api) }
    }

    func signOut() async {
        await use { api in
            try await api.perform(.logout)
            await clearAuthorization(api)
            if message == nil { message = "This device was signed out and revoked." }
        }
    }

    func changeServer() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await api?.close()
        do { while polling { try await Task.sleep(for: .milliseconds(30)) } }
        catch { return }
        api = nil
        selection = nil
        clearWorkspace(keepDrafts: false)
        message = nil
        screen = .connect
    }

    func navigate(_ next: Panel, reply: String? = nil) async {
        await use { api in
            setPanel(next, reply: reply)
            try await refreshPanel(api)
        }
    }

    func backFromThread() async { await navigate(threadBack) }

    private func setPanel(_ next: Panel, reply: String? = nil) {
        if case .thread = next {
            if case .thread = panel {} else { threadBack = panel }
        }
        panel = next
        seen.removeAll()
        turns = []
        updates = [:]
        catalog = nil
        replyTarget = reply
    }

    func refresh() async { await use { try await refreshWorkspace($0) } }

    func refreshForeground() async {
        guard screen == .workspace else { return }
        await use(quiet: true) { api in
            if file != nil { try await checkFileAuthorization(api) }
            else { try await refreshWorkspace(api) }
        }
    }

    func tick() async {
        guard !busy, !polling, screen == .workspace else { return }
        if let catalogExpiresAt, ContinuousClock.now >= catalogExpiresAt {
            catalog = nil
            self.catalogExpiresAt = nil
        }
        if file != nil, ContinuousClock.now >= nextFileAuthorization {
            await use(quiet: true) { try await checkFileAuthorization($0) }
            return
        }
        if !seen.isEmpty {
            await use(quiet: true) { try await sendSeen($0) }
        }
        guard lastRefresh.duration(to: .now) >= .seconds(5) else { return }
        switch panel {
        case .thread, .inbox:
            await use(quiet: true) { try await refreshWorkspace($0) }
        default:
            guard lastRefresh.duration(to: .now) >= .seconds(18) else { return }
            await use(quiet: true) { try await refreshWorkspace($0) }
        }
    }

    func markVisible(chat: String, turn: String, visible: Bool) {
        guard panel == .thread(chat) else { return }
        if visible, !marked.contains(turn) { seen.insert(turn) }
        if !visible { seen.remove(turn) }
    }

    func suspendReadReceipts() { seen.removeAll() }

    func suspendForBackground() {
        suspendReadReceipts()
        dismissFile()
    }

    private func sendSeen(_ api: NativeAPI) async throws {
        guard case .thread(let chat) = panel else { return }
        for id in Array(seen) where seen.contains(id) {
            try await api.perform(.readReply(chat: chat, id: id))
            marked.insert(id)
            seen.remove(id)
        }
    }

    private func refreshWorkspace(_ api: NativeAPI) async throws {
        directory = try await api.directory()
        try await refreshPanel(api)
    }

    private func refreshPanel(_ api: NativeAPI) async throws {
        defer { lastRefresh = .now }
        switch panel {
        case .thread(let chat): try await loadThread(chat, api: api)
        case .inbox: inbox = try await api.inbox()
        case .settings: try await loadSettings(api)
        case .directory, .category: break
        }
    }

    private func loadThread(_ chat: String, api: NativeAPI) async throws {
        let items = try await api.history(chat: chat)
        var newUpdates: [String: [TurnUpdate]] = [:]
        for turn in items { newUpdates[turn.id] = try await api.updates(chat: chat, turn: turn.id) }
        turns = items
        updates = newUpdates
    }

    private func loadSettings(_ api: NativeAPI) async throws {
        let receipt: ProfileReceipt = try await api.call(.profile, .profile)
        profile = receipt.profile
        backends = try await api.backends()
        devices = try await api.devices()
    }

    func mutate(_ request: NativeRequest, _ outcome: OutcomeKind) async {
        await use { api in
            try await api.perform(request, outcome)
            try await refreshWorkspace(api)
        }
    }

    func decide(chat: String, id: String, choice: ApprovalChoice, clearDraft: Bool = false) async {
        await use { api in
            if clearDraft { drafts[.thread(chat)] = nil }
            try await api.perform(.decideApproval(chat: chat, id: id, choice: choice))
            try await loadThread(chat, api: api)
        }
    }

    func fetchCatalog() async {
        await use { api in
            let receipt: CatalogReceipt = try await api.call(.slashCatalog, .slashCatalog)
            catalog = receipt.catalog
            catalogExpiresAt = catalog == nil ? nil : .now.advanced(by: .seconds(15))
            if catalog == nil { message = "No live slash directory. You can still type a command." }
        }
    }

    func report(_ error: any Error) {
        switch error {
        case let error as APIError: message = error.errorDescription
        case let failure as SessionKeychain.Failure:
            message = "Couldn’t access Keychain (code \(failure.status)). Unlock this iPhone and try again."
        case NoiseFailure.Identity: message = "Server identity did not match the trusted pin. Check it out of band."
        case is NoiseFailure, is DecodingError: message = APIError.incompatible.errorDescription
        case is CancellationError: message = "The operation was canceled. Reconnect before continuing."
        default: message = "Couldn’t complete the operation. Check your file or private network and try again."
        }
    }

    private func use(quiet: Bool = false, transfer: Bool = false, _ run: (NativeAPI) async throws -> Void) async {
        guard screen == .workspace, !busy else { return }
        if quiet {
            guard !polling, let api else { return }
            polling = true
            defer { polling = false }
            do { try await run(api) }
            catch { await handle(error, api: api) }
            return
        }
        busy = true
        defer { busy = false; transferring = false }
        do {
            while polling { try await Task.sleep(for: .milliseconds(30)) }
            guard screen == .workspace, let api else { return }
            transferring = transfer
            message = nil
            try await run(api)
        } catch {
            if let api { await handle(error, api: api) }
        }
    }

    private func handle(_ error: any Error, api: NativeAPI) async {
        report(error)
        if case APIError.rejected(.unauthorized, _) = error, screen != .signIn || device != nil {
            await clearAuthorization(api)
        } else if !(await api.isConnected) {
            await api.close()
            clearWorkspace(keepDrafts: true)
            screen = .reconnect
        }
    }

    private func clearAuthorization(_ api: NativeAPI, next: Screen = .reconnect) async {
        clearWorkspace(keepDrafts: false)
        screen = next
        await api.close()
        do { try store.remove(for: api.selection) }
        catch { report(error) }
    }

    private func clearWorkspace(keepDrafts: Bool) {
        device = nil
        directory = nil
        turns = []
        updates = [:]
        inbox = []
        devices = []
        profile = nil
        backends = []
        catalog = nil
        dismissFile()
        seen = []
        marked = []
        for scope in Array(drafts.keys) { drafts[scope]?.approval = nil }
        if !keepDrafts {
            panel = .directory
            threadBack = .directory
            replyTarget = nil
            drafts = [:]
            pending = [:]
        }
    }

    private func isSlash(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") }

    private func approvalCommand(_ text: String) -> ApprovalChoice? {
        let words = text.lowercased().split(whereSeparator: \.isWhitespace)
        return switch words {
        case ["/approve"], ["/approve", "once"]: .once
        case ["/approve", "session"]: .session
        case ["/deny"]: .deny
        default: nil
        }
    }
}

extension Workspace {
    func download(_ id: String) async {
        await use(transfer: true) { api in
            let generation = fileGeneration
            let result = try await api.download(id: id)
            try await checkFileAuthorization(api)
            guard generation == fileGeneration else { result.discard(); return }
            file = result
        }
    }

    func authorizeFileExport(_ presented: DownloadedFile) async -> Bool {
        var allowed = false
        await use { api in
            guard file === presented else { return }
            try await checkFileAuthorization(api)
            allowed = file === presented
        }
        return allowed
    }

    private func checkFileAuthorization(_ api: NativeAPI) async throws {
        do {
            try await api.validateMediaAccess()
            nextFileAuthorization = .now.advanced(by: .seconds(1))
        } catch {
            dismissFile()
            throw error
        }
    }

    func dismissFile() {
        fileGeneration += 1
        file?.discard()
        file = nil
    }

    func cancelTransfer() async {
        guard transferring else { return }
        await api?.close()
    }
}

extension Workspace {
    func draft(_ scope: DraftScope) -> Draft { drafts[scope] ?? Draft() }
    func awaitingReceipt(_ scope: DraftScope) -> Bool { pending[scope] != nil }
    func discardPending(_ scope: DraftScope) { if !busy { pending[scope] = nil } }

    func setText(_ text: String, scope: DraftScope) {
        guard pending[scope] == nil else { return }
        var draft = draft(scope)
        if !isSlash(text) { draft.approval = nil }
        else if !isSlash(draft.text), case .thread = scope {
            let cards = updates.values.flatMap { $0 }.filter { !$0.choices.isEmpty }
            draft.approval = cards.count == 1 ? cards.first?.id : nil
        }
        draft.text = text
        drafts[scope] = draft
    }

    func removeAttachment(_ id: String, scope: DraftScope) {
        guard !busy, pending[scope] == nil else { return }
        drafts[scope]?.attachments.removeAll { $0.id == id }
    }

    func attach(_ files: [URL], scope: DraftScope) async {
        guard pending[scope] == nil else { return }
        guard draft(scope).attachments.count + files.count <= 8 else { message = "A message can have up to eight files."; return }
        await use(transfer: true) { api in
            for file in files {
                let attachment = try await api.upload(file, purpose: .turn, mime: nil)
                var updated = draft(scope)
                updated.attachments.append(attachment)
                drafts[scope] = updated
            }
        }
    }

    func send(_ scope: DraftScope) async {
        let draft = draft(scope)
        guard draft.hasContent else { return }
        if let choice = approvalCommand(draft.text) {
            guard case .thread(let chat) = scope, let id = draft.approval, draft.attachments.isEmpty,
                  updates.values.flatMap({ $0 }).contains(where: { $0.id == id && $0.choices.contains(choice) }) else {
                message = "Use a currently displayed approval card for this decision. It was not sent."
                return
            }
            await decide(chat: chat, id: id, choice: choice, clearDraft: true)
            return
        }
        await use { api in
            let value = pending[scope] ?? WireMessage(id: UUID().uuidString.lowercased(), text: draft.text,
                                                     attachments: draft.attachments.map(\.id))
            pending[scope] = value
            do { try await enqueue(value, in: scope, api: api) }
            catch APIError.rejected(let code, let detail) {
                if code != .unauthorized { pending[scope] = nil }
                throw APIError.rejected(code, detail)
            }
            pending[scope] = nil
            drafts[scope] = nil
            try await refreshWorkspace(api)
        }
    }

    private func enqueue(_ value: WireMessage, in scope: DraftScope, api: NativeAPI) async throws {
        switch scope {
        case .category(let category):
            let receipt: CreatedThread = try await api.call(.startThread(channel: category, message: value), .threadStarted)
            guard receipt.id == value.id else { throw APIError.incompatible }
            setPanel(.thread(receipt.id))
        case .thread(let chat):
            let receipt: QueuedTurn = try await api.call(.sendTurn(chat: chat, message: value), .turnSent)
            guard receipt.id == value.id else { throw APIError.incompatible }
        }
    }
}

extension Workspace {
    func settingsProfile(_ role: IdentityRole, patch: IdentityPatch) async {
        await use { api in try await patchProfile(api, role: role, patch: patch) }
    }

    func updateAvatar(_ role: IdentityRole, url: URL) async {
        await use(transfer: true) { api in
            let item = try await api.upload(url, purpose: .avatar, mime: nil)
            try await patchProfile(api, role: role, patch: IdentityPatch(avatar: .set(item.id)))
        }
    }

    private func patchProfile(_ api: NativeAPI, role: IdentityRole, patch: IdentityPatch) async throws {
        let request = NativeRequest.updateProfile(owner: role == .owner ? patch : nil, agent: role == .agent ? patch : nil)
        let receipt: ProfileReceipt = try await api.call(request, .profile)
        profile = receipt.profile
    }

    func syncProfile(_ backend: String?) async {
        await use { api in
            let receipt: ProfileReceipt = try await api.call(.syncProfile(backend: backend), .profile)
            profile = receipt.profile
            switch receipt.profile.sync?.refresh {
            case .refreshed: message = "Agent profile refreshed."
            case .timedOut: message = "The backend didn’t respond before the refresh deadline."
            case .offline: message = "The backend is offline."
            case nil: break
            }
            backends = try await api.backends()
        }
    }

    func revoke(_ id: String) async {
        await use { api in
            let result: Revocation = try await api.call(.revokeDevice(id: id), .revoked)
            if result.current { await clearAuthorization(api) }
            else { devices = try await api.devices() }
        }
    }
}
