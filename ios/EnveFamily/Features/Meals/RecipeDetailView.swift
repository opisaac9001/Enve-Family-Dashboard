import SwiftUI

struct RecipeDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let recipeId: String
    @State private var servings: Int?
    @State private var scaledIngredients: String?
    @State private var isEditing = false
    @State private var isPlanning = false
    @State private var isConfirmingDelete = false
    @State private var message: String?

    var body: some View {
        if let recipe = model.state?.recipes.first(where: { $0.id == recipeId }) {
            content(for: recipe)
        } else {
            ContentUnavailableView("Recipe Not Found", systemImage: "book")
        }
    }

    private func content(for recipe: Recipe) -> some View {
        let currentServings = servings ?? recipe.servings
        let ingredients = (currentServings == recipe.servings ? recipe.ingredients : scaledIngredients ?? recipe.ingredients)
            .split(whereSeparator: \.isNewline)
            .map(String.init)
        return List {
            if let photoId = recipe.photoId {
                RemotePhotoView(photoId: photoId)
                    .frame(height: 220)
                    .listRowInsets(EdgeInsets())
            }

            Section {
                Stepper("Serves \(currentServings)", value: Binding(get: { currentServings }, set: { servings = $0 }), in: 1...24)
            }

            Section("Ingredients") {
                ForEach(Array(ingredients.enumerated()), id: \.offset) { _, line in
                    Text(line)
                }
            }

            if !recipe.directions.isEmpty {
                Section("Directions") {
                    Text(recipe.directions)
                }
            }

            Section {
                Button("Add Ingredients to Groceries") { addToGroceries(servings: currentServings) }
                Button("Plan This Meal") { isPlanning = true }
            } footer: {
                if let message { Text(message) }
            }
        }
        .navigationTitle(recipe.title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Edit Recipe") { isEditing = true }
                    Button("Delete Recipe", role: .destructive) { isConfirmingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Recipe Options")
            }
        }
        .task(id: currentServings) {
            await loadScaledIngredients(for: recipe, servings: currentServings)
        }
        .sheet(isPresented: $isEditing) {
            NavigationStack {
                RecipeEditorView(recipe: recipe) {
                    isEditing = false
                    servings = nil
                    scaledIngredients = nil
                }
            }
            .pinPromptHost(level: 1)
        }
        .sheet(isPresented: $isPlanning) {
            NavigationStack {
                MealEditorView(week: model.mealWeek, recipe: recipe, servings: currentServings) { isPlanning = false }
            }
            .pinPromptHost(level: 1)
        }
        .confirmationDialog("Delete \(recipe.title)?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete Recipe", role: .destructive) {
                let id = recipe.id
                Task {
                    await model.run { try await $0.deleteRecipe(id) }
                    dismiss()
                }
            }
        } message: {
            Text("It will be removed from the recipe box.")
        }
    }

    private func loadScaledIngredients(for recipe: Recipe, servings: Int) async {
        guard servings != recipe.servings else { return }
        let id = recipe.id
        do {
            scaledIngredients = try await model.call { try await $0.scaledIngredients(for: id, servings: servings) }
        } catch {
            model.banner = error.localizedDescription
        }
    }

    private func addToGroceries(servings: Int) {
        let id = recipeId
        message = nil
        Task {
            do {
                let added = try await model.mutate { try await $0.addRecipeToGroceries(id, servings: servings) }
                message = added == 1 ? "Added 1 item to Groceries." : "Added \(added) items to Groceries."
            } catch {
                model.banner = error.localizedDescription
            }
        }
    }
}
