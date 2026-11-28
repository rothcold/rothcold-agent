import Foundation

enum APIError: LocalizedError {
    case invalidAddress, invalidPin, incompatible, disconnected, connectionInUse, localFile, keychainWrite
    case rejected(Rejection, String)

    var errorDescription: String? {
        switch self {
        case .invalidAddress: "Enter a private IP address, optionally followed by a port (default 8768). Use brackets for IPv6."
        case .invalidPin: "Enter the independently verified 64-character server pin."
        case .incompatible: "The server returned an invalid or incompatible Noise response."
        case .disconnected: "The connection closed. Check your private network, then reconnect."
        case .connectionInUse: "Wait for the current request to finish."
        case .localFile: "Couldn’t read or write the entire file locally."
        case .keychainWrite: "Couldn’t save the device credential. Check the device list from another device for any new enrollment."
        case .rejected(let code, let message):
            code == .unauthorized ? "Sign-in was rejected or this device session is no longer valid." : message
        }
    }
}

struct WireMessage: Encodable, Sendable, Equatable {
    let id: String
    let text: String
    let attachments: [String]
}

enum AvatarPatch: Encodable, Sendable {
    case clear, set(String)

    func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: Key.self)
        switch self {
        case .clear: try box.encode("clear", forKey: .type)
        case .set(let id):
            try box.encode("set", forKey: .type)
            try box.encode(id, forKey: .id)
        }
    }

    private enum Key: String, CodingKey { case type, id }
}

struct IdentityPatch: Encodable, Sendable {
    var name: String?
    var avatar: AvatarPatch?
}

enum UploadPurpose: String, Encodable, Sendable {
    case turn, avatar
    var limit: UInt64 { (self == .avatar ? 5 : 25) * 1024 * 1024 }
}

enum ApprovalChoice: String, Codable, Sendable, Identifiable {
    case once, session, deny
    var id: Self { self }
    var label: String {
        switch self {
        case .once: "Allow once"
        case .session: "Allow for session"
        case .deny: "Deny"
        }
    }
}

struct NativeRequest: Encodable, Sendable {
    private enum Kind: String, Encodable, Sendable {
        case status
        case login = "login_native"
        case resume = "resume_native"
        case me, logout
        case devices
        case revokeDevice = "revoke_device"
        case profile
        case profileBackends = "profile_backends"
        case updateProfile = "update_profile"
        case syncProfile = "sync_profile"
        case slashCatalog = "slash_catalog"
        case categories
        case threads
        case createCategory = "create_category"
        case renameCategory = "rename_category"
        case archiveCategory = "archive_category"
        case startThread = "start_thread"
        case renameThread = "rename_thread"
        case moveThread = "move_thread"
        case archiveThread = "archive_thread"
        case history
        case turnUpdates = "turn_updates"
        case sendTurn = "send_turn"
        case releaseTurn = "release_turn"
        case decideApproval = "decide_approval"
        case inbox
        case readThread = "read_thread"
        case readReply = "read_reply"
        case upload
        case uploadFinish = "upload_finish"
        case download
        case downloadNext = "download_next"
    }

    private let type: Kind
    private var ownerToken: String?
    private var name: String?
    private var pin: [UInt8]?
    private var credential: [UInt8]?
    private var after: String?
    private var id: String?
    private var owner: IdentityPatch?
    private var agent: IdentityPatch?
    private var backend: String?
    private var includeArchived: Bool?
    private var archived: Bool?
    private var channel: String?
    private var message: WireMessage?
    private var title: String?
    private var chat: String?
    private var turn: String?
    private var choice: ApprovalChoice?
    private var purpose: UploadPurpose?
    private var filename: String?
    private var size: UInt64?
    private var mime: String?

    static var status: Self { Self(type: .status) }
    static func login(owner: String, name: String) -> Self { Self(type: .login, ownerToken: owner, name: name) }
    static func resume(pin: Data, credential: Data) -> Self {
        Self(type: .resume, pin: Array(pin), credential: Array(credential))
    }
    static var me: Self { Self(type: .me) }
    static var logout: Self { Self(type: .logout) }
    static func devices(after: String?) -> Self { Self(type: .devices, after: after) }
    static func revokeDevice(id: String) -> Self { Self(type: .revokeDevice, id: id) }
    static var profile: Self { Self(type: .profile) }
    static func profileBackends(after: String?) -> Self { Self(type: .profileBackends, after: after) }
    static func updateProfile(owner: IdentityPatch?, agent: IdentityPatch?) -> Self {
        Self(type: .updateProfile, owner: owner, agent: agent)
    }
    static func syncProfile(backend: String?) -> Self { Self(type: .syncProfile, backend: backend) }
    static var slashCatalog: Self { Self(type: .slashCatalog) }
    static func categories(after: String?) -> Self { Self(type: .categories, after: after, includeArchived: true) }
    static func threads(after: String?) -> Self { Self(type: .threads, after: after, includeArchived: true) }
    static func createCategory(name: String) -> Self { Self(type: .createCategory, name: name) }
    static func renameCategory(id: String, name: String) -> Self { Self(type: .renameCategory, name: name, id: id) }
    static func archiveCategory(id: String, archived: Bool) -> Self { Self(type: .archiveCategory, id: id, archived: archived) }
    static func startThread(channel: String, message: WireMessage) -> Self {
        Self(type: .startThread, channel: channel, message: message)
    }
    static func renameThread(id: String, title: String) -> Self { Self(type: .renameThread, id: id, title: title) }
    static func moveThread(id: String, channel: String) -> Self { Self(type: .moveThread, id: id, channel: channel) }
    static func archiveThread(id: String, archived: Bool) -> Self { Self(type: .archiveThread, id: id, archived: archived) }
    static func history(chat: String, after: String?) -> Self { Self(type: .history, after: after, chat: chat) }
    static func turnUpdates(chat: String, turn: String, after: String?) -> Self {
        Self(type: .turnUpdates, after: after, chat: chat, turn: turn)
    }
    static func sendTurn(chat: String, message: WireMessage) -> Self { Self(type: .sendTurn, message: message, chat: chat) }
    static func releaseTurn(chat: String, id: String) -> Self { Self(type: .releaseTurn, id: id, chat: chat) }
    static func decideApproval(chat: String, id: String, choice: ApprovalChoice) -> Self {
        Self(type: .decideApproval, id: id, chat: chat, choice: choice)
    }
    static func inbox(after: String?) -> Self { Self(type: .inbox, after: after) }
    static func readThread(chat: String) -> Self { Self(type: .readThread, chat: chat) }
    static func readReply(chat: String, id: String) -> Self { Self(type: .readReply, id: id, chat: chat) }
    static func upload(purpose: UploadPurpose, filename: String, size: UInt64, mime: String?) -> Self {
        Self(type: .upload, purpose: purpose, filename: filename, size: size, mime: mime)
    }
    static var uploadFinish: Self { Self(type: .uploadFinish) }
    static func download(id: String) -> Self { Self(type: .download, id: id) }
    static var downloadNext: Self { Self(type: .downloadNext) }
}

enum OutcomeKind: String, Decodable, Sendable {
    case status, nativeLogin = "native_login", device, devices, revoked, profile
    case profileBackends = "profile_backends", slashCatalog = "slash_catalog", categories, threads
    case categoryCreated = "category_created", categoryRenamed = "category_renamed", archived
    case threadStarted = "thread_started", threadRenamed = "thread_renamed", threadMoved = "thread_moved"
    case history, turnUpdates = "turn_updates", turnSent = "turn_sent", inbox, ok
}

struct Outcome<Payload: Decodable>: Decodable {
    let type: OutcomeKind
    let payload: Payload
    private enum Key: String, CodingKey { case type }

    init(from decoder: any Decoder) throws {
        type = try decoder.container(keyedBy: Key.self).decode(OutcomeKind.self, forKey: .type)
        payload = try Payload(from: decoder)
    }
}

struct EmptyResult: Decodable, Sendable {}
struct Page<T: Decodable & Sendable>: Decodable, Sendable {
    let items: [T]
    let next: String?
}
struct Paged<T: Decodable & Sendable>: Decodable, Sendable { let page: Page<T> }
struct ServiceStatus: Decodable, Sendable { let service: String; let version: UInt16 }
struct LoginReceipt: Decodable, Sendable { let pin: [UInt8]; let credential: [UInt8]; let device: Device }
struct DeviceReceipt: Decodable, Sendable { let device: Device }
struct DevicePage: Decodable, Sendable { let current: String; let page: Page<Device> }
struct Revocation: Decodable, Sendable { let current: Bool }
struct CreatedThread: Decodable, Sendable { let id: String; let title: String; let channel: String; let fresh: Bool }
struct QueuedTurn: Decodable, Sendable { let id: String; let fresh: Bool }

struct Device: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let createdAt: Int64
    let expiresAt: Int64
}

extension DirectoryCategory: Decodable, Identifiable {
    private enum Key: String, CodingKey { case id, name, archived }
    public init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Key.self)
        self.init(id: try box.decode(String.self, forKey: .id), name: try box.decode(String.self, forKey: .name),
                  archived: try box.decode(Bool.self, forKey: .archived))
    }
}
extension DirectoryThread: Decodable, Identifiable {
    private enum Key: String, CodingKey { case id, title, channel, archived }
    public init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Key.self)
        self.init(id: try box.decode(String.self, forKey: .id), title: try box.decode(String.self, forKey: .title),
                  channel: try box.decode(String.self, forKey: .channel), archived: try box.decode(Bool.self, forKey: .archived))
    }
}
extension NativeAttachment: Decodable, Identifiable {
    private enum Key: String, CodingKey { case id, filename, mime, kind, size }
    public init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Key.self)
        self.init(id: try box.decode(String.self, forKey: .id), filename: try box.decode(String.self, forKey: .filename),
                  mime: try box.decode(String.self, forKey: .mime), kind: try box.decode(String.self, forKey: .kind),
                  size: try box.decode(UInt64.self, forKey: .size))
    }
}

struct Turn: Decodable, Sendable, Identifiable {
    enum State: String, Decodable, Sendable { case queued, reserved, accepted, unknown, released, answered }
    let id: String
    let text: String
    let state: State
    let answer: String?
    let attachments: [NativeAttachment]
}

struct TurnUpdate: Decodable, Sendable, Identifiable {
    enum Kind: String, Decodable, Sendable { case progress, commentary }
    let id: String
    let kind: Kind
    let text: String
    let choices: [ApprovalChoice]
}

struct InboxEntry: Decodable, Sendable, Identifiable {
    let request: String
    let chat: String
    let channel: String
    let unread: Bool
    let title: String
    let preview: String
    var id: String { "\(chat):\(request)" }
}

struct Profile: Decodable, Sendable {
    let owner: Identity
    let agent: Identity
    let sync: SyncResult?

    struct Identity: Decodable, Sendable { let name: String; let avatar: String? }
    struct SyncResult: Decodable, Sendable {
        enum Refresh: String, Decodable, Sendable { case refreshed, timedOut = "timed_out", offline }
        let backend: String
        let refresh: Refresh
        let name: Bool
        let avatar: Bool
    }
}
struct ProfileReceipt: Decodable, Sendable { let profile: Profile }
struct BackendProfile: Decodable, Identifiable, Sendable {
    let id: String
    let kind: String
    let name: String
    let avatar: String?
    let updatedAt: Int64
}
struct SlashCatalog: Decodable, Sendable { let commands: [String]; let skills: [String] }
struct CatalogReceipt: Decodable, Sendable { let catalog: SlashCatalog? }
