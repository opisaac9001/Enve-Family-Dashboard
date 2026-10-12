import Foundation
import Security

struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? { "The sign-in couldn't be saved to the Keychain (\(status))." }
}

struct LoginCredentials: Codable, Sendable {
    let username: String?
    let password: String
}

enum KeychainStore {
    private static let service = "com.enve.family.access-key"

    static func credentials(for server: URL) -> LoginCredentials? {
        var query = baseQuery(for: server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        if let credentials = try? JSONDecoder().decode(LoginCredentials.self, from: data) { return credentials }
        guard let key = String(data: data, encoding: .utf8) else { return nil }
        return LoginCredentials(username: nil, password: key)
    }

    static func save(_ credentials: LoginCredentials, for server: URL) throws {
        SecItemDelete(baseQuery(for: server) as CFDictionary)
        var query = baseQuery(for: server)
        query[kSecValueData as String] = try JSONEncoder().encode(credentials)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func delete(for server: URL) {
        SecItemDelete(baseQuery(for: server) as CFDictionary)
    }

    private static func baseQuery(for server: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: server.absoluteString,
        ]
    }
}
