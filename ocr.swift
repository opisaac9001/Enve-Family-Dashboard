import AppKit
import Foundation
import PDFKit
import Vision

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

let data = FileHandle.standardInput.readDataToEndOfFile()
var pages: [String] = []

if let document = PDFDocument(data: data) {
    for index in 0..<min(document.pageCount, 5) {
        guard let page = document.page(at: index) else { continue }
        let embedded = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !embedded.isEmpty {
            pages.append(embedded)
        } else if let image = page.thumbnail(of: NSSize(width: 1800, height: 2400), for: .mediaBox)
            .cgImage(forProposedRect: nil, context: nil, hints: nil) {
            pages.append(try recognize(image))
        }
    }
} else if let image = NSImage(data: data)?.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    pages.append(try recognize(image))
} else {
    fputs("Unsupported image or PDF\n", stderr)
    exit(2)
}

print(pages.joined(separator: "\n\n").prefix(20000))
