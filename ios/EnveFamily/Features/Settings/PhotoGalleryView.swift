import SwiftUI

/// Read-only view of the photos the dashboard's photo frame shows.
struct PhotoGalleryView: View {
    @Environment(AppModel.self) private var model
    @State private var photoIds: [String]?
    @State private var errorMessage: String?
    @State private var selected: PhotoSelection?

    var body: some View {
        ScrollView {
            if let photoIds, !photoIds.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 2)], spacing: 2) {
                    ForEach(photoIds, id: \.self) { id in
                        Button { selected = PhotoSelection(id: id) } label: {
                            RemotePhotoView(photoId: id)
                                .aspectRatio(1, contentMode: .fit)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Photo")
                    }
                }
            }
        }
        .overlay {
            if let errorMessage {
                ContentUnavailableView("Couldn't Load Photos", systemImage: "photo.on.rectangle", description: Text(errorMessage))
            } else if photoIds == nil {
                ProgressView()
            } else if photoIds?.isEmpty == true {
                ContentUnavailableView("No Photos", systemImage: "photo.on.rectangle",
                                       description: Text("Add photo frame pictures from the dashboard on the server computer."))
            }
        }
        .navigationTitle("Photo Frame")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .fullScreenCover(item: $selected) { photo in
            PhotoViewer(photoId: photo.id)
        }
    }

    /// Accepts `[...]` or `{ photos: [...] }`, where each entry is an id string or an object with `id`.
    private func load() async {
        do {
            let json = try await model.call { try await $0.photos() }
            let entries = json.array ?? json["photos"]?.array ?? []
            photoIds = entries.compactMap { $0.string ?? $0["id"]?.string }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct PhotoSelection: Identifiable {
    let id: String
}

private struct PhotoViewer: View {
    @Environment(\.dismiss) private var dismiss
    let photoId: String

    var body: some View {
        NavigationStack {
            RemotePhotoView(photoId: photoId, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.black)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
                .toolbarBackground(.hidden, for: .navigationBar)
        }
    }
}
