import SwiftUI

struct RecipeEditorView: View {
    @Environment(AppModel.self) private var model
    let recipe: Recipe?
    let onSave: () -> Void
    let onComplete: () -> Void

    @State private var title: String
    @State private var servings: Int
    @State private var ingredients: String
    @State private var directions: String
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(recipe: Recipe?, draft: RecipeDraft? = nil, onSave: @escaping () -> Void = {}, onComplete: @escaping () -> Void) {
        self.recipe = recipe
        self.onSave = onSave
        self.onComplete = onComplete
        _title = State(initialValue: recipe?.title ?? draft?.title ?? "")
        _servings = State(initialValue: recipe?.servings ?? 4)
        _ingredients = State(initialValue: recipe?.ingredients ?? draft?.ingredients ?? "")
        _directions = State(initialValue: recipe?.directions ?? draft?.directions ?? "")
    }

    var body: some View {
        Form {
            Section {
                TextField("Recipe name", text: $title)
                Stepper("Serves \(servings)", value: $servings, in: 1...24)
            }

            Section {
                TextField("One ingredient per line", text: $ingredients, axis: .vertical)
                    .lineLimit(5...30)
            } header: {
                Text("Ingredients")
            } footer: {
                Text("Up to 30 ingredients.")
            }

            Section("Directions") {
                TextField("Directions", text: $directions, axis: .vertical)
                    .lineLimit(4...20)
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(recipe == nil ? "New Recipe" : "Edit Recipe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onComplete)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty
                              || ingredients.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || isSaving)
            }
        }
    }

    private func save() {
        // PATCH replaces photo_id, so the existing photo must be sent back to keep it.
        let payload = RecipePayload(title: title.trimmingCharacters(in: .whitespaces), ingredients: ingredients,
                                    directions: directions, servings: servings, photoId: recipe?.photoId)
        let id = recipe?.id
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.mutate { try await $0.saveRecipe(payload, id: id) }
                onSave()
                onComplete()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
