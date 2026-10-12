import SwiftUI

struct RecipesView: View {
    @Environment(AppModel.self) private var model
    @State private var isCreating = false

    var body: some View {
        let recipes = model.state?.recipes ?? []
        List {
            if recipes.isEmpty {
                ContentUnavailableView("No Recipes", systemImage: "book", description: Text("Save family favorites to plan meals and fill the grocery list."))
            }
            ForEach(recipes) { recipe in
                NavigationLink {
                    RecipeDetailView(recipeId: recipe.id)
                } label: {
                    LabeledContent(recipe.title, value: "Serves \(recipe.servings)")
                }
            }
        }
        .refreshable { await model.load() }
        .navigationTitle("Recipe Box")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { isCreating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New Recipe")
            }
        }
        .sheet(isPresented: $isCreating) {
            NavigationStack {
                RecipeEditorView(recipe: nil) { isCreating = false }
            }
            .pinPromptHost(level: 1)
        }
    }
}
