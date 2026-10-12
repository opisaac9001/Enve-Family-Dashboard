import SwiftUI

struct MealDetailView: View {
    private struct EditTarget: Identifiable {
        let scope: MealScope?

        var id: String { scope?.rawValue ?? "meal" }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let mealId: String
    @State private var editTarget: EditTarget?
    @State private var isChoosingEditScope = false
    @State private var deleting: Meal?

    var body: some View {
        if let state = model.state, let meal = state.meals.first(where: { $0.id == mealId }) {
            content(meal, state: state)
        } else {
            ContentUnavailableView("Meal Not Found", systemImage: "fork.knife")
        }
    }

    private func content(_ meal: Meal, state: FamilyState) -> some View {
        let category = state.mealCategory(meal.category)
        return List {
            Section {
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: category.color))
                        .frame(width: 4)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(category.name.uppercased())
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color(hex: category.color))
                        Text(meal.title).font(.title2.bold())
                        Text(FamilyDates.day(fromKey: meal.day)?.formatted(.dateTime.weekday(.wide).month(.wide).day()) ?? meal.day)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }

            let servings = meal.recipeIds.isEmpty ? nil : meal.servings
            if servings != nil || meal.isRepeating {
                Section {
                    if let servings {
                        LabeledContent("Serves", value: "\(servings)")
                    }
                    if let repeatSummary = meal.repeatSummary {
                        LabeledContent("Repeat", value: repeatSummary)
                    }
                }
            }

            if !meal.recipeIds.isEmpty {
                Section("Recipes") {
                    ForEach(meal.recipeIds, id: \.self) { id in
                        if let recipe = state.recipe(id) {
                            NavigationLink { RecipeDetailView(recipeId: id) } label: {
                                Label(recipe.title, systemImage: "book")
                            }
                        } else {
                            Label("Deleted recipe", systemImage: "book")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if !meal.notes.isEmpty {
                Section("Notes") {
                    Text(meal.notes)
                }
            }

            Section {
                Button("Edit Meal") {
                    if meal.isRepeating { isChoosingEditScope = true } else { editTarget = EditTarget(scope: nil) }
                }
                Button("Delete Meal", role: .destructive) { deleting = meal }
            } footer: {
                if model.isOffline { Text("Editing and deleting meals need a connection to the server.") }
            }
            .disabled(model.isOffline)
        }
        .navigationTitle("Meal")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Edit Repeating Meal", isPresented: $isChoosingEditScope, titleVisibility: .visible) {
            Button("Only This Meal") { editTarget = EditTarget(scope: .occurrence) }
            Button("This and Later Meals") { editTarget = EditTarget(scope: .series) }
        } message: {
            Text("Earlier repeats stay as they are.")
        }
        .sheet(item: $editTarget) { target in
            NavigationStack {
                MealEditorView(week: model.mealWeek, editing: meal, scope: target.scope) { editTarget = nil }
            }
            .pinPromptHost(level: 1)
        }
        .mealDeletion($deleting) { dismiss() }
    }
}

extension View {
    /// Asks which repeats to delete for a repeating meal, then confirms before deleting.
    func mealDeletion(_ meal: Binding<Meal?>, onDeleted: @escaping () -> Void = {}) -> some View {
        modifier(MealDeletion(meal: meal, onDeleted: onDeleted))
    }
}

private struct MealDeletion: ViewModifier {
    private struct Pending {
        let meal: Meal
        let scope: MealScope?
    }

    @Environment(AppModel.self) private var model
    @Binding var meal: Meal?
    let onDeleted: () -> Void
    @State private var confirmed: Pending?

    private var pending: Pending? {
        confirmed ?? meal.flatMap { $0.isRepeating ? nil : Pending(meal: $0, scope: nil) }
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Delete Repeating Meal",
                isPresented: Binding(get: { meal?.isRepeating == true && confirmed == nil }, set: { if !$0 { meal = nil } }),
                titleVisibility: .visible,
                presenting: meal
            ) { meal in
                Button("Only This Meal") { confirmed = Pending(meal: meal, scope: .occurrence) }
                Button("This and Later Meals") { confirmed = Pending(meal: meal, scope: .series) }
            } message: { _ in
                Text("Earlier repeats stay as they are.")
            }
            .alert(
                title(for: pending),
                isPresented: Binding(get: { pending != nil }, set: { if !$0 { confirmed = nil; meal = nil } }),
                presenting: pending
            ) { pending in
                Button("Delete", role: .destructive) { delete(pending) }
                Button("Cancel", role: .cancel) {}
            } message: { pending in
                Text(message(for: pending))
            }
    }

    private func title(for pending: Pending?) -> String {
        switch pending?.scope {
        case .series: "Delete This and Later Meals?"
        default: "Delete Meal?"
        }
    }

    private func message(for pending: Pending) -> String {
        let day = FamilyDates.day(fromKey: pending.meal.day)?.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()) ?? pending.meal.day
        return switch pending.scope {
        case .series: "\(pending.meal.title) on \(day) and every later repeat will be removed."
        case .occurrence: "Only \(pending.meal.title) on \(day) will be removed. Other repeats stay."
        case nil: "\(pending.meal.title) on \(day) will be removed from the plan."
        }
    }

    private func delete(_ pending: Pending) {
        let id = pending.meal.id
        let scope = pending.scope
        Task {
            if await model.run({ try await $0.deleteMeal(id, scope: scope) }) { onDeleted() }
        }
    }
}
