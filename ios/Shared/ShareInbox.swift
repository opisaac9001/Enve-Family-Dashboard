import Foundation

/// An item the share extension saved for the app to import. Paths are always built from `id`, never from manifest text.
struct PendingShare: Codable, Identifiable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case text, pdf, image
    }

    let id: UUID
    let createdAt: Date
    let kind: Kind
    /// Display only: a file name or the start of the shared text.
    let title: String
    let byteCount: Int
}

enum ShareInboxError: LocalizedError {
    case unavailable
    case full
    case tooLarge
    case unreadable

    var errorDescription: String? {
        switch self {
        case .unavailable: "Sharing isn't set up for this copy of Enve Family: its App Group isn't available."
        case .full: "\(ShareInbox.maxItems) shared items are already waiting. Open Enve Family to review or discard them first."
        case .tooLarge: "Shared files must be 5 MB or less."
        case .unreadable: "This shared item couldn't be read."
        }
    }
}

/// Hand-off between the share extension and the app through the App Group container.
/// The extension only adds entries; the app lists, reads, and removes them.
enum ShareInbox {
    struct Listing: Sendable {
        var shares: [PendingShare] = []
        /// Entries whose manifest or payload is missing or malformed, so they can still be discarded.
        var unreadable: [UUID] = []
    }

    /// The server rejects decoded import files over 5 MB.
    static let maxPayloadSize = 5_000_000
    static let maxItems = 20
    static let maxTitleLength = 80
    private static let maxManifestSize = 16_384
    private static let manifestName = "manifest.json"
    private static let payloadName = "payload"
    private static let stagingName = ".incoming"

    private static var directory: URL {
        get throws {
            guard let group = Bundle.main.object(forInfoDictionaryKey: "EnveAppGroup") as? String, !group.isEmpty,
                  let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
                throw ShareInboxError.unavailable
            }
            return container.appending(path: "ShareInbox", directoryHint: .isDirectory)
        }
    }

    // MARK: Extension

    /// Writes into a staging folder first and moves it into place, so the app never sees a partial entry.
    @discardableResult
    static func add(_ kind: PendingShare.Kind, title: String, payload: Data) throws -> PendingShare {
        guard !payload.isEmpty else { throw ShareInboxError.unreadable }
        guard payload.count <= maxPayloadSize else { throw ShareInboxError.tooLarge }
        let inbox = try directory
        guard try entryURLs(in: inbox).count < maxItems else { throw ShareInboxError.full }

        let share = PendingShare(id: UUID(), createdAt: .now, kind: kind, title: String(title.prefix(maxTitleLength)), byteCount: payload.count)
        let staging = inbox.appending(path: stagingName, directoryHint: .isDirectory).appending(path: share.id.uuidString, directoryHint: .isDirectory)
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        do {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var inboxURL = inbox
            try inboxURL.setResourceValues(values)
            try payload.write(to: staging.appending(path: payloadName), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try JSONEncoder().encode(share).write(to: staging.appending(path: manifestName), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try fileManager.moveItem(at: staging, to: inbox.appending(path: share.id.uuidString, directoryHint: .isDirectory))
        } catch {
            try? fileManager.removeItem(at: staging)
            throw error
        }
        return share
    }

    // MARK: App

    static func listing() throws -> Listing {
        let inbox = try directory
        var listing = Listing()
        for (id, url) in try entryURLs(in: inbox) {
            if let share = try? manifest(at: url, id: id) {
                listing.shares.append(share)
            } else {
                listing.unreadable.append(id)
            }
        }
        listing.shares.sort { $0.createdAt < $1.createdAt }
        return listing
    }

    static func payload(for share: PendingShare) throws -> Data {
        let url = try directory.appending(path: share.id.uuidString, directoryHint: .isDirectory).appending(path: payloadName)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == share.byteCount,
              share.byteCount <= maxPayloadSize else { throw ShareInboxError.unreadable }
        let data = try Data(contentsOf: url)
        guard data.count == share.byteCount else { throw ShareInboxError.unreadable }
        return data
    }

    static func remove(_ id: UUID) throws {
        let url = try directory.appending(path: id.uuidString, directoryHint: .isDirectory)
        guard FileManager.default.fileExists(atPath: url.path()) else { return }
        try FileManager.default.removeItem(at: url)
    }

    /// Clears staging folders left by an extension that was killed mid-write.
    static func removeAbandonedStaging() {
        guard let staging = try? directory.appending(path: stagingName, directoryHint: .isDirectory),
              let urls = try? FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: [.creationDateKey]) else { return }
        let cutoff = Date.now.addingTimeInterval(-3600)
        for url in urls {
            let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
            if created < cutoff { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// Entry folders named by a canonical UUID; anything else in the inbox is ignored.
    private static func entryURLs(in inbox: URL) throws -> [(UUID, URL)] {
        guard FileManager.default.fileExists(atPath: inbox.path()) else { return [] }
        let urls = try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: .skipsHiddenFiles)
        return urls.compactMap { url in
            guard let id = UUID(uuidString: url.lastPathComponent), id.uuidString == url.lastPathComponent,
                  let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true else { return nil }
            return (id, url)
        }
    }

    private static func manifest(at entry: URL, id: UUID) throws -> PendingShare {
        let url = entry.appending(path: manifestName)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? .max) <= maxManifestSize else {
            throw ShareInboxError.unreadable
        }
        let share = try JSONDecoder().decode(PendingShare.self, from: Data(contentsOf: url))
        guard share.id == id, share.byteCount > 0, share.byteCount <= maxPayloadSize else { throw ShareInboxError.unreadable }
        let payload = try entry.appending(path: payloadName).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard payload.isRegularFile == true, payload.isSymbolicLink != true, payload.fileSize == share.byteCount else {
            throw ShareInboxError.unreadable
        }
        return share
    }
}
