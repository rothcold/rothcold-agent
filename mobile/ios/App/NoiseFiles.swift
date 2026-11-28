import Foundation

struct AttachmentInput: Sendable {
    let filename: String
    let handle: FileHandle
    let size: UInt64

    init(url: URL, purpose: UploadPurpose) throws {
        guard url.isFileURL,
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, let length = values.fileSize, length >= 0 else { throw APIError.localFile }
        guard length > 0, UInt64(length) <= purpose.limit else {
            throw APIError.rejected(.limit, "Choose a nonempty file up to \(purpose.limit / 1_048_576) MiB.")
        }
        guard let handle = try? FileHandle(forReadingFrom: url) else { throw APIError.localFile }
        self.handle = handle
        filename = url.lastPathComponent
        size = UInt64(length)
    }

    func chunk(count: Int) throws -> Data {
        var data = Data()
        while data.count < count {
            guard let piece = try? handle.read(upToCount: count - data.count), !piece.isEmpty else {
                throw APIError.localFile
            }
            data.append(piece)
        }
        return data
    }
}

final class DownloadedFile: Identifiable, Sendable {
    let attachment: NativeAttachment
    let url: URL
    private let directory: URL
    private static let directoryPrefix = "rothcold-noise-file-"

    var id: String { attachment.id }

    init(_ attachment: NativeAttachment) throws {
        self.attachment = attachment
        let safeName = attachment.filename
        guard !["", ".", ".."].contains(safeName), !safeName.contains("/"), !safeName.contains("\\"),
              !safeName.contains(where: \.isNewline), !safeName.utf8.contains(0) else { throw APIError.incompatible }
        directory = FileManager.default.temporaryDirectory.appending(path: Self.directoryPrefix + UUID().uuidString)
        url = directory.appending(path: safeName)
        var directoryAttributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        var fileAttributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS)
        directoryAttributes[.protectionKey] = FileProtectionType.complete
        fileAttributes[.protectionKey] = FileProtectionType.complete
        #endif
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: directoryAttributes)
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: fileAttributes) else {
                throw APIError.localFile
            }
        } catch {
            discard()
            throw APIError.localFile
        }
    }

    deinit { discard() }

    func discard() { try? FileManager.default.removeItem(at: directory) }

    static func discardPreviousDownloads() {
        let manager = FileManager.default
        let files = try? manager.contentsOfDirectory(at: manager.temporaryDirectory, includingPropertiesForKeys: nil)
        for file in files ?? [] where file.lastPathComponent.hasPrefix(directoryPrefix) {
            try? manager.removeItem(at: file)
        }
    }
}

extension WireLink {
    func upload(_ input: AttachmentInput, purpose: UploadPurpose, mime: String?) async throws -> NativeAttachment {
        let start = NativeRequest.upload(purpose: purpose, filename: input.filename, size: input.size, mime: mime)
        try await send(start)
        guard case .uploadReady = try await receive() else { throw APIError.incompatible }
        var remaining = input.size
        var sequence: UInt32 = 0
        let deadline = ContinuousClock.now.advanced(by: .seconds(120))
        while remaining > 0 {
            try checkTransfer(deadline)
            let count = Int(min(remaining, UInt64(nativeChunkBytes())))
            let bytes = try input.chunk(count: count)
            try await socket.write(codec.uploadChunk(sequence: sequence, bytes: bytes))
            guard case .uploadChunkAccepted(let accepted) = try await receive(), accepted == sequence else {
                throw APIError.incompatible
            }
            sequence += 1
            remaining -= UInt64(count)
        }
        guard (try input.handle.read(upToCount: 1) ?? Data()).isEmpty else { throw APIError.localFile }
        try checkTransfer(deadline)
        try await send(.uploadFinish)
        guard case .uploadComplete(let item) = try await receive(), item.size == input.size else {
            throw APIError.incompatible
        }
        return item
    }

    func download(id: String) async throws -> DownloadedFile {
        try await send(.download(id: id))
        guard case .downloadStart(let item) = try await receive(), item.id == id, item.size <= UploadPurpose.turn.limit else {
            throw APIError.incompatible
        }
        let file = try DownloadedFile(item)
        do {
            let handle = try FileHandle(forWritingTo: file.url)
            defer { try? handle.close() }
            try await receiveFile(item.size, into: handle)
            try handle.synchronize()
            return file
        } catch {
            file.discard()
            throw error
        }
    }

    private func receiveFile(_ size: UInt64, into handle: FileHandle) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(120))
        var sequence: UInt32 = 0
        var remaining = size
        while remaining > 0 {
            try checkTransfer(deadline)
            try await send(.downloadNext)
            let count = Int(min(remaining, UInt64(nativeChunkBytes())))
            guard case .downloadChunk(let next, let bytes) = try await receive(), next == sequence, bytes.count == count else {
                throw APIError.incompatible
            }
            try handle.write(contentsOf: bytes)
            sequence += 1
            remaining -= UInt64(count)
        }
        try checkTransfer(deadline)
        try await send(.downloadNext)
        guard case .downloadComplete = try await receive() else { throw APIError.incompatible }
    }

    private func checkTransfer(_ deadline: ContinuousClock.Instant) throws {
        try Task.checkCancellation()
        guard ContinuousClock.now < deadline else { throw APIError.disconnected }
    }
}
