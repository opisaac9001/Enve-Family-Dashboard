import SwiftUI

struct ProfilesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List(model.state?.profiles ?? []) { profile in
            NavigationLink {
                ProfileEditorView(profile: profile)
            } label: {
                ProfileLabel(profile: profile)
            }
        }
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ProfileEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let profile: Profile

    @State private var name: String
    @State private var color: Color
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(profile: Profile) {
        self.profile = profile
        _name = State(initialValue: profile.name)
        _color = State(initialValue: Color(hex: profile.color))
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                    .textContentType(.givenName)
                ColorPicker("Color", selection: $color, supportsOpacity: false)
            } footer: {
                Text("The color marks this person's events, tasks, and rewards on every device.")
            }

            Section {
                ProfileLabel(profile: Profile(id: profile.id, name: trimmedName.isEmpty ? profile.name : trimmedName, color: color.hexString))
            } header: {
                Text("Preview")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(profile.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(trimmedName.isEmpty || isSaving || (trimmedName == profile.name && color.hexString == profile.color.uppercased()))
            }
        }
    }

    private func save() {
        let id = profile.id
        let name = trimmedName
        let color = color.hexString
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.mutate { try await $0.updateProfile(id, name: name, color: color) }
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
