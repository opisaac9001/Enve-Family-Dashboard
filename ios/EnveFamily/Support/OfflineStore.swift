import Foundation

/// Durable storage for the last good `/api/state` response and creates waiting for the server.
enum OfflineStore {
    struct CachedState: Codable {
        let server: String
        let savedAt: Date
        let data: Data
    }

    private static var directory: URL {
        URL.applicationSupportDirectory.appending(path: "Offline", directoryHint: .isDirectory)
    }

    private static var stateURL: URL { directory.appending(path: "state.json") }
    private static var pendingURL: URL { directory.appending(path: "pending.json") }

    static func cachedState(for server: URL) -> CachedState? {
        guard let data = try? Data(contentsOf: stateURL),
              let cached = try? JSONDecoder().decode(CachedState.self, from: data),
              cached.server == server.absoluteString else { return nil }
        return cached
    }

    static func saveState(_ data: Data, for server: URL) {
        let cached = CachedState(server: server.absoluteString, savedAt: .now, data: data)
        try? write(cached, to: stateURL, excludedFromBackup: true)
    }

    static func clearState() {
        try? FileManager.default.removeItem(at: stateURL)
    }

    static func pendingChanges() -> [PendingChange] {
        guard let data = try? Data(contentsOf: pendingURL) else { return [] }
        return (try? JSONDecoder().decode([PendingChange].self, from: data)) ?? []
    }

    static func savePendingChanges(_ changes: [PendingChange]) throws {
        if changes.isEmpty {
            if FileManager.default.fileExists(atPath: pendingURL.path()) { try FileManager.default.removeItem(at: pendingURL) }
        } else {
            try write(changes, to: pendingURL, excludedFromBackup: false)
        }
    }

    private static func write(_ value: some Encodable, to url: URL, excludedFromBackup: Bool) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if excludedFromBackup {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = url
            try url.setResourceValues(values)
        }
    }
}
