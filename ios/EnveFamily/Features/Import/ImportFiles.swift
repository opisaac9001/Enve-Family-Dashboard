import UIKit
import UniformTypeIdentifiers

enum ImportFileError: LocalizedError {
    case tooLarge
    case unreadable

    var errorDescription: String? {
        switch self {
        case .tooLarge: "Choose a file under 5 MB."
        case .unreadable: "That file couldn't be opened. Choose a PDF, photo, or text file."
        }
    }
}

/// Prepares picked files and photos in memory; nothing is written to disk.
enum ImportFiles {
    static let allowedTypes: [UTType] = [.pdf, .image, .plainText, .calendarEvent]
    private static let serverImageTypes: [UTType] = [.jpeg, .png, .webP]

    static func source(fromFile url: URL) throws -> ImportSource {
        let isScoped = url.startAccessingSecurityScopedResource()
        defer { if isScoped { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        guard (values.fileSize ?? 0) <= ImportSource.maxFileSize else { throw ImportFileError.tooLarge }
        let type = values.contentType ?? .data
        let data = try Data(contentsOf: url)
        if type.conforms(to: .plainText) || type.conforms(to: .calendarEvent) {
            guard let text = String(data: data, encoding: .utf8) else { throw ImportFileError.unreadable }
            return .text(text)
        }
        if type.conforms(to: .pdf) || serverImageTypes.contains(where: type.conforms(to:)) {
            return .file(data)
        }
        // HEIC and other image formats the server can't read are converted to JPEG.
        guard type.conforms(to: .image), let image = UIImage(data: data) else { throw ImportFileError.unreadable }
        return try source(from: image)
    }

    /// Items from the share extension are already text, a PDF, or a downscaled JPEG; this only checks they still are.
    static func source(fromShare share: PendingShare) throws -> ImportSource {
        let data = try ShareInbox.payload(for: share)
        switch share.kind {
        case .text:
            guard let text = String(data: data, encoding: .utf8) else { throw ImportFileError.unreadable }
            return .text(text)
        case .pdf:
            guard data.starts(with: Data("%PDF".utf8)) else { throw ImportFileError.unreadable }
            return .file(data)
        case .image:
            guard data.starts(with: [0xFF, 0xD8, 0xFF]) else { throw ImportFileError.unreadable }
            return .file(data)
        }
    }

    static func source(fromPhotoData data: Data) throws -> ImportSource {
        guard let image = UIImage(data: data) else { throw ImportFileError.unreadable }
        return try source(from: image)
    }

    /// Downscales to a size that keeps text legible for OCR while staying well under the upload limit.
    static func source(from image: UIImage) throws -> ImportSource {
        let maxDimension: CGFloat = 2560
        let scale = min(1, maxDimension / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let data = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.8) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard data.count <= ImportSource.maxFileSize else { throw ImportFileError.tooLarge }
        return .file(data)
    }
}
