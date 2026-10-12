import SwiftUI

struct RewardEditorView: View {
    enum Kind: String, Identifiable {
        case reward, goal

        var id: Self { self }
    }

    @Environment(AppModel.self) private var model
    let kind: Kind
    let onComplete: () -> Void

    @State private var title = ""
    @State private var profileId = "family"
    @State private var stars = 10
    @State private var errorMessage: String?
    @State private var isSaving = false

    var body: some View {
        Form {
            Section {
                TextField(kind == .reward ? "Reward" : "Goal", text: $title)
                ProfilePicker(selection: $profileId)
                HStack {
                    Text(kind == .reward ? "Cost" : "Target")
                    Spacer()
                    TextField("Stars", value: $stars, format: .number)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 80)
                    Text("★")
                }
            } footer: {
                Text(kind == .reward ? "Stars are spent when the reward is redeemed." : "Goals track progress toward a star total without spending stars.")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(kind == .reward ? "New Reward" : "New Goal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onComplete)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || !(1...1000).contains(stars) || isSaving)
            }
        }
    }

    private func save() {
        let title = title.trimmingCharacters(in: .whitespaces)
        let profileId = profileId
        let stars = stars
        let kind = kind
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.mutate { client in
                    switch kind {
                    case .reward: try await client.createReward(title: title, profileId: profileId, cost: stars)
                    case .goal: try await client.createGoal(title: title, profileId: profileId, target: stars)
                    }
                }
                onComplete()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
