import Foundation
import Network

struct ServerSelection: Hashable, Sendable {
    let address: String
    let pin: Data

    var pinHex: String { pin.map { String(format: "%02x", $0) }.joined() }
    var keychainAccount: String { "\(address)|\(pinHex)" }

    init(address: String, pin: String) throws {
        let endpoint = try Self.parse(address)
        self.address = endpoint.address
        let hex = Array(pin.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        guard hex.count == 64 else { throw APIError.invalidPin }
        var key = Data()
        for index in stride(from: 0, to: hex.count, by: 2) {
            guard let high = Self.nibble(hex[index]), let low = Self.nibble(hex[index + 1]) else {
                throw APIError.invalidPin
            }
            key.append(high << 4 | low)
        }
        self.pin = key
    }

    func endpoint() throws -> NWEndpoint {
        let parsed = try Self.parse(address)
        return .hostPort(host: parsed.host, port: parsed.port)
    }

    private static func nibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: byte - 48
        case 65...70: byte - 65 + 10
        case 97...102: byte - 97 + 10
        default: nil
        }
    }

    private static func parse(_ input: String) throws -> (address: String, host: NWEndpoint.Host, port: NWEndpoint.Port) {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = value.split(separator: ":", omittingEmptySubsequences: false)
        let host: NWEndpoint.Host
        let label: String
        let portText: Substring?
        if value.hasPrefix("["), let end = value.firstIndex(of: "]"),
           let v6 = IPv6Address(String(value[value.index(after: value.startIndex)..<end])), v6.interface == nil {
            let suffix = value[value.index(after: end)...]
            guard suffix.isEmpty || suffix.hasPrefix(":"),
                  v6.isLoopback || (v6.rawValue.first.map { $0 & 0xfe == 0xfc } ?? false) else {
                throw APIError.invalidAddress
            }
            host = .ipv6(v6)
            label = "[\(v6.debugDescription)]"
            portText = suffix.isEmpty ? nil : suffix.dropFirst()
        } else if fields.count <= 2, let part = fields.first, let v4 = IPv4Address(String(part)) {
            let bytes = Array(v4.rawValue)
            guard bytes[0] == 10 || bytes[0] == 127 ||
                    (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
                    (bytes[0] == 192 && bytes[1] == 168) ||
                    (bytes[0] == 100 && (64...127).contains(bytes[1])) else { throw APIError.invalidAddress }
            host = .ipv4(v4)
            label = bytes.map(String.init).joined(separator: ".")
            portText = fields.count == 2 ? fields[1] : nil
        } else {
            throw APIError.invalidAddress
        }
        let number: UInt16
        if let portText {
            guard !portText.isEmpty, portText.utf8.allSatisfy({ (48...57).contains($0) }),
                  let port = UInt16(portText), port > 0 else { throw APIError.invalidAddress }
            number = port
        } else {
            number = 8768
        }
        guard let port = NWEndpoint.Port(rawValue: number) else { throw APIError.invalidAddress }
        return ("\(label):\(number)", host, port)
    }
}

/// The serial queue owns all continuation and NWConnection state; at most one I/O is pending.
final class NoiseSocket: @unchecked Sendable {
    private enum Operation: Sendable { case send(Data), receive(Int) }
    private let queue = DispatchQueue(label: "org.rothcold.agent.noise-tcp")
    private let connection: NWConnection
    private var pending: CheckedContinuation<Data, any Error>?
    private var generation = 0
    private var closed = false

    init(endpoint: NWEndpoint) {
        connection = NWConnection(to: endpoint, using: .tcp)
        connection.start(queue: queue)
    }

    deinit { connection.cancel() }

    func close() { queue.async { self.stop(with: APIError.disconnected) } }

    func write(_ packet: Data, timeout: TimeInterval = 30) async throws {
        guard !packet.isEmpty, let length = UInt16(exactly: packet.count) else { throw APIError.incompatible }
        var data = Data([UInt8(length >> 8), UInt8(truncatingIfNeeded: length)])
        data.append(packet)
        _ = try await perform(.send(data), timeout: timeout)
    }

    func read(timeout: TimeInterval = 30) async throws -> Data {
        let prefix = Array(try await perform(.receive(2), timeout: timeout))
        let size = Int(prefix[0]) << 8 | Int(prefix[1])
        guard size > 0 else { throw APIError.incompatible }
        return try await perform(.receive(size), timeout: timeout)
    }

    private func perform(_ operation: Operation, timeout: TimeInterval) async throws -> Data {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                queue.async { self.start(operation, timeout: timeout, continuation: continuation) }
            }
        } onCancel: { close() }
    }

    private func start(_ operation: Operation, timeout: TimeInterval,
                       continuation: CheckedContinuation<Data, any Error>) {
        guard !closed, pending == nil else {
            continuation.resume(throwing: APIError.disconnected)
            return
        }
        pending = continuation
        generation += 1
        let id = generation
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, self.generation == id, self.pending != nil else { return }
            self.stop(with: APIError.disconnected)
        }
        switch operation {
        case .send(let bytes):
            connection.send(content: bytes, completion: .contentProcessed { [weak self] error in
                self?.finish(id, bytes: error == nil ? Data() : nil)
            })
        case .receive(let count):
            connection.receive(minimumIncompleteLength: count, maximumLength: count) { [weak self] bytes, _, _, error in
                self?.finish(id, bytes: error == nil && bytes?.count == count ? bytes : nil)
            }
        }
    }

    private func finish(_ id: Int, bytes: Data?) {
        guard generation == id, let pending else { return }
        guard let bytes else { stop(with: APIError.disconnected); return }
        self.pending = nil
        pending.resume(returning: bytes)
    }

    private func stop(with error: APIError) {
        guard !closed else { return }
        closed = true
        connection.cancel()
        let callback = pending
        pending = nil
        callback?.resume(throwing: error)
    }
}
