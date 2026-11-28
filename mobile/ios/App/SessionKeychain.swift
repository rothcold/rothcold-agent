import Foundation
import Security

protocol SessionStore {
    func read(for selection: ServerSelection) throws -> Data?
    func save(_ session: Data, for selection: ServerSelection) throws
    func remove(for selection: ServerSelection) throws
}

struct SessionKeychain: SessionStore {
    struct Failure: Error { let status: OSStatus }

    private func query(for selection: ServerSelection) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "org.rothcold.agent.noise-v1.device-credential",
         kSecAttrAccount as String: selection.keychainAccount,
         kSecAttrSynchronizable as String: false,
         kSecUseDataProtectionKeychain as String: true]
    }

    func read(for selection: ServerSelection) throws -> Data? {
        var lookup = query(for: selection)
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        guard let data = result as? Data, data.count == 32 else { throw Failure(status: errSecDecode) }
        return data
    }

    func save(_ session: Data, for selection: ServerSelection) throws {
        guard session.count == 32 else { throw Failure(status: errSecParam) }
        let lookup = query(for: selection)
        let attributes: [String: Any] = [kSecValueData as String: session,
                                         kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(lookup as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(lookup.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    func remove(for selection: ServerSelection) throws {
        let status = SecItemDelete(query(for: selection) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
    }
}
