import SwiftUI
import UniformTypeIdentifiers

struct BackupView: View {
    @Environment(AppModel.self) private var model

    @State private var backup: BackupDocument?
    @State private var isExporting = false
    @State private var isImporting = false
    @State private var restoreCandidate: RestoreCandidate?
    @State private var isWorking = false
    @State private var message: String?

    var body: some View {
        Form {
            Section {
                Button(action: makeBackup) { Label("Save Backup to Files", systemImage: "square.and.arrow.down") }
            } footer: {
                Text("Exports all household data from the server as a JSON file. Calendar account tokens and passwords stay on the server.")
            }

            Section {
                Button(role: .destructive) { isImporting = true } label: {
                    Label("Restore from Backup…", systemImage: "arrow.counterclockwise")
                }
            } footer: {
                Text("Replaces everything on the server, for every device, with the backup's contents. This can't be undone, so save a fresh backup first.")
            }

            if isWorking {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Working…").foregroundStyle(.secondary)
                    }
                }
            } else if let message {
                Section {
                    Text(message).font(.callout)
                }
            }
        }
        .disabled(isWorking)
        .navigationTitle("Backup & Restore")
        .navigationBarTitleDisplayMode(.inline)
        .fileExporter(isPresented: $isExporting, document: backup, contentType: .json, defaultFilename: defaultFilename) { result in
            switch result {
            case .success: message = "Backup saved."
            case .failure(let error): message = error.localizedDescription
            }
            backup = nil
        }
        .fileImporter(isPresented: $isImporting, allowedContentTypes: [.json]) { result in
            switch result {
            case .success(let url): prepareRestore(from: url)
            case .failure(let error): message = error.localizedDescription
            }
        }
        .confirmationDialog("Replace All Household Data?", isPresented: Binding(
            get: { restoreCandidate != nil },
            set: { if !$0 { restoreCandidate = nil } }
        ), titleVisibility: .visible, presenting: restoreCandidate) { candidate in
            Button("Erase and Restore", role: .destructive) { restore(candidate) }
        } message: { candidate in
            Text("Every event, task, list, meal, recipe, reward, and setting on the server will be replaced with “\(candidate.name)”. Changes made since that backup will be lost on every device.")
        }
    }

    private var defaultFilename: String {
        "Enve Family Backup \(FamilyDates.dayKey(.now)).json"
    }

    private func makeBackup() {
        isWorking = true
        message = nil
        Task {
            do {
                let data = try await model.call { try await $0.backup() }
                backup = BackupDocument(data: data)
                isExporting = true
            } catch {
                message = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func prepareRestore(from url: URL) {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
                message = "That file isn't an Enve Family backup."
                return
            }
            restoreCandidate = RestoreCandidate(name: url.lastPathComponent, data: data)
        } catch {
            message = error.localizedDescription
        }
    }

    private func restore(_ candidate: RestoreCandidate) {
        let data = candidate.data
        restoreCandidate = nil
        isWorking = true
        message = nil
        Task {
            do {
                try await model.mutate { try await $0.restore(data) }
                message = "Restored from “\(candidate.name)”."
            } catch {
                message = error.localizedDescription
            }
            isWorking = false
        }
    }
}

private struct RestoreCandidate {
    let name: String
    let data: Data
}

private struct BackupDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
