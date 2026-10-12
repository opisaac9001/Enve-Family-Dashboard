import SwiftUI

/// A server photo from `/api/photos/:id`, drawn over a placeholder that takes the frame it's given.
struct RemotePhotoView: View {
    @Environment(AppModel.self) private var model
    let photoId: String
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?

    var body: some View {
        Rectangle()
            .fill(contentMode == .fill ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear))
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
                } else if contentMode == .fit {
                    ProgressView()
                }
            }
            .clipped()
            .task(id: photoId) {
                let id = photoId
                if let data = try? await model.call({ try await $0.photo(id: id) }) {
                    image = UIImage(data: data)
                }
            }
    }
}
