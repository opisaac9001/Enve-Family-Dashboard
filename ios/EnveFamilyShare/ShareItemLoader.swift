import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum ShareItemError: LocalizedError {
    case unsupported

    var errorDescription: String? {
        "Enve Family can import text, links, photos, PDFs, and calendar (.ics) files."
    }
}

/// Saves what was shared into the App Group inbox. Text and links from one share become a single item; each file is its own item.
/// Nothing here touches the network or the Keychain.
@MainActor
struct ShareItemLoader {
    struct Outcome {
        var saved = 0
        var problems: [String] = []
    }

    static let maxAttachments = 10
    /// Photos are downscaled here, so only refuse sources that are unreasonably large to decode in an extension.
    nonisolated private static let maxImageSourceSize = 50_000_000
    nonisolated private static let maxImageDimension = 2560

    func save(_ items: [NSExtensionItem]) async -> Outcome {
        var outcome = Outcome()
        var texts: [String] = []
        if let context = items.compactMap({ $0.attributedContentText?.string.trimmed }).first(where: { !$0.isEmpty }) {
            texts.append(context)
        }

        let providers = items.flatMap { $0.attachments ?? [] }
        if providers.count > Self.maxAttachments {
            outcome.problems.append("Only the first \(Self.maxAttachments) of \(providers.count) items were saved.")
        }
        for provider in providers.prefix(Self.maxAttachments) {
            do {
                if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
                    let name = Self.fileTitle(provider, fallback: "PDF")
                    let data = try await loadFile(provider, type: .pdf) { url in
                        let data = try Self.readSmallFile(url)
                        guard data.starts(with: Data("%PDF".utf8)) else { throw ShareInboxError.unreadable }
                        return data
                    }
                    try add(.pdf, title: name, payload: data, to: &outcome)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.calendarEvent.identifier) {
                    let name = Self.fileTitle(provider, fallback: "Calendar file")
                    let data = try await loadFile(provider, type: .calendarEvent) { url in
                        let data = try Self.readSmallFile(url)
                        guard String(data: data, encoding: .utf8) != nil else { throw ShareInboxError.unreadable }
                        return data
                    }
                    try add(.text, title: name, payload: data, to: &outcome)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    let name = Self.fileTitle(provider, fallback: "Photo")
                    try add(.image, title: name, payload: try await loadImage(provider), to: &outcome)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    texts.append(try await loadText(provider))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    texts.append(try await loadWebURL(provider))
                } else {
                    throw ShareItemError.unsupported
                }
            } catch let error as ShareInboxError where error == .full || error == .unavailable {
                outcome.problems.append(error.localizedDescription)
                return outcome
            } catch {
                outcome.problems.append(error.localizedDescription)
            }
        }

        var seen = Set<String>()
        let text = texts.map(\.trimmed).filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: "\n\n")
        if !text.isEmpty {
            do {
                let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Text"
                try add(.text, title: firstLine, payload: Data(text.utf8), to: &outcome)
            } catch {
                outcome.problems.append(error.localizedDescription)
            }
        }
        if outcome.saved == 0 && outcome.problems.isEmpty {
            outcome.problems.append(ShareItemError.unsupported.localizedDescription)
        }
        return outcome
    }

    private func add(_ kind: PendingShare.Kind, title: String, payload: Data, to outcome: inout Outcome) throws {
        try ShareInbox.add(kind, title: title, payload: payload)
        outcome.saved += 1
    }

    // MARK: Loading

    /// The provider's copy is deleted when its handler returns, so the file is read inside it.
    private func loadFile(_ provider: NSItemProvider, type: UTType, read: @escaping @Sendable (URL) throws -> Data) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { @Sendable url, _, error in
                guard let url else {
                    continuation.resume(throwing: error ?? ShareInboxError.unreadable)
                    return
                }
                continuation.resume(with: Result { try read(url) })
            }
        }
    }

    private func loadImage(_ provider: NSItemProvider) async throws -> Data {
        do {
            return try await loadFile(provider, type: .image) { url in
                let size = (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? .max
                guard size <= Self.maxImageSourceSize, let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                    throw size > Self.maxImageSourceSize ? ShareInboxError.tooLarge : ShareInboxError.unreadable
                }
                return try Self.jpeg(from: source)
            }
        } catch let error as ShareInboxError {
            throw error
        } catch {
            // Some apps (screenshots, Markup) only offer in-memory image data.
            return try await withCheckedThrowingContinuation { continuation in
                _ = provider.loadDataRepresentation(for: .image) { @Sendable data, error in
                    guard let data else {
                        continuation.resume(throwing: error ?? ShareInboxError.unreadable)
                        return
                    }
                    continuation.resume(with: Result {
                        guard data.count <= Self.maxImageSourceSize else { throw ShareInboxError.tooLarge }
                        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw ShareInboxError.unreadable }
                        return try Self.jpeg(from: source)
                    })
                }
            }
        }
    }

    private func loadText(_ provider: NSItemProvider) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { @Sendable item, error in
                continuation.resume(with: Result {
                    let text: String? = switch item {
                    case let string as String: string
                    case let attributed as NSAttributedString: attributed.string
                    case let data as Data: data.count <= ShareInbox.maxPayloadSize ? String(data: data, encoding: .utf8) : nil
                    case let url as URL where url.isFileURL: String(data: try Self.readSmallFile(url), encoding: .utf8)
                    default: nil
                    }
                    guard let text else { throw error ?? ShareInboxError.unreadable }
                    return text
                })
            }
        }
    }

    private func loadWebURL(_ provider: NSItemProvider) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { @Sendable item, error in
                let url: URL? = switch item {
                case let url as URL: url
                case let data as Data: URL(dataRepresentation: data, relativeTo: nil)
                case let string as String: URL(string: string)
                default: nil
                }
                if let url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) {
                    continuation.resume(returning: url.absoluteString)
                } else if url?.isFileURL == true {
                    continuation.resume(throwing: ShareItemError.unsupported)
                } else {
                    continuation.resume(throwing: error ?? ShareInboxError.unreadable)
                }
            }
        }
    }

    // MARK: Files

    nonisolated private static func readSmallFile(_ url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw ShareInboxError.unreadable }
        guard (values.fileSize ?? .max) <= ShareInbox.maxPayloadSize else { throw ShareInboxError.tooLarge }
        let data = try Data(contentsOf: url)
        guard data.count <= ShareInbox.maxPayloadSize else { throw ShareInboxError.tooLarge }
        return data
    }

    /// Matches the app's photo import: JPEG, longest edge 2560 px. ImageIO avoids decoding the full-size image.
    nonisolated private static func jpeg(from source: CGImageSource) throws -> Data {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxImageDimension,
        ]
        let output = NSMutableData()
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let destination = CGImageDestinationCreateWithData(output as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ShareInboxError.unreadable
        }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let flattened = context.makeImage() else { throw ShareInboxError.unreadable }
        CGImageDestinationAddImage(destination, flattened, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw ShareInboxError.unreadable }
        guard output.length <= ShareInbox.maxPayloadSize else { throw ShareInboxError.tooLarge }
        return output as Data
    }

    private static func fileTitle(_ provider: NSItemProvider, fallback: String) -> String {
        provider.suggestedName?.trimmed.nonEmpty ?? fallback
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var nonEmpty: String? { isEmpty ? nil : self }
}
