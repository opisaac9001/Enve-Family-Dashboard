import SwiftUI

struct MealsView: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model
    @State private var isAdding = false
    @State private var isSuggesting = false
    @State private var isEditingCategories = false
    @State private var isAddingGroceries = false
    @State private var deleting: Meal?
    @State private var message: String?

    var body: some View {
        let week = model.mealWeek
        let linkedMealIds = week.flatMap(meals(on:)).filter { !$0.recipeIds.isEmpty }.map(\.id)
        NavigationStack {
            List {
                Section {
                    HStack {
                        Button { model.moveWeek(by: -1) } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("Previous Week")
                        Spacer()
                        Text("\(week[0].formatted(.dateTime.month(.abbreviated).day())) – \(week[6].formatted(.dateTime.month(.abbreviated).day()))")
                            .font(.headline)
                        Spacer()
                        Button { model.moveWeek(by: 1) } label: { Image(systemName: "chevron.right") }
                            .accessibilityLabel("Next Week")
                    }
                    .buttonStyle(.borderless)
                    NavigationLink {
                        RecipesView()
                    } label: {
                        Label("Recipe Box (\(model.state?.recipes.count ?? 0))", systemImage: "book")
                    }
                    Button { isSuggesting = true } label: {
                        Label("Suggest Meals", systemImage: "wand.and.stars")
                    }
                    .disabled(model.isOffline)
                    if !linkedMealIds.isEmpty {
                        Button { addToGroceries(linkedMealIds) } label: {
                            Label("Add This Week's Recipes to Groceries", systemImage: "cart.badge.plus")
                        }
                        .disabled(isAddingGroceries || model.isOffline)
                    }
                } footer: {
                    if let message { Text(message) }
                }

                ForEach(week, id: \.self) { day in
                    let dayMeals = meals(on: day)
                    Section {
                        if dayMeals.isEmpty {
                            Text("No meals planned.").foregroundStyle(.secondary)
                        }
                        ForEach(dayMeals) { meal in
                            NavigationLink { MealDetailView(mealId: meal.id) } label: { mealRow(meal) }
                                .swipeActions {
                                    if !model.isOffline {
                                        Button("Delete") { deleting = meal }
                                            .tint(.red)
                                    }
                                }
                        }
                    } header: {
                        Text(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                            .foregroundStyle(Calendar.current.isDateInToday(day) ? accent : Color.secondary)
                    }
                }
            }
            .refreshable { await model.load() }
            .navigationTitle("Meals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SettingsButton() }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { isEditingCategories = true } label: { Image(systemName: "tag") }
                        .accessibilityLabel("Meal Types")
                        .disabled(model.isOffline || model.state == nil)
                    Button { isAdding = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Plan Meal")
                }
            }
            .mealDeletion($deleting)
            .sheet(isPresented: $isAdding) {
                NavigationStack {
                    MealEditorView(week: week) { isAdding = false }
                }
                .pinPromptHost(level: 1)
            }
            .sheet(isPresented: $isSuggesting) {
                NavigationStack {
                    MealSuggestionsView(week: week, onSaved: { message = $0 }) { isSuggesting = false }
                }
                .pinPromptHost(level: 1)
            }
            .sheet(isPresented: $isEditingCategories) {
                NavigationStack {
                    MealCategoriesView(categories: model.state?.allMealCategories ?? MealCategory.defaults) { isEditingCategories = false }
                }
                .pinPromptHost(level: 1)
            }
        }
    }

    private func mealRow(_ meal: Meal) -> some View {
        let category = model.state?.mealCategory(meal.category)
        let recipeTitles = meal.recipeIds.compactMap { model.state?.recipe($0)?.title }
        let servings = meal.recipeIds.isEmpty ? nil : meal.servings
        return HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(hex: category?.color ?? "#F5921A"))
                .frame(width: 4)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                let name = (category?.name ?? meal.category).uppercased()
                Text(servings.map { "\(name) · SERVES \($0)" } ?? name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(hex: category?.color ?? "#F5921A"))
                Text(meal.title)
                if !recipeTitles.isEmpty {
                    Label(recipeTitles.joined(separator: ", "), systemImage: "book")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Recipes: \(recipeTitles.joined(separator: ", "))")
                }
                if let repeatSummary = meal.repeatSummary {
                    Label(repeatSummary, systemImage: "repeat")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if !meal.notes.isEmpty {
                    Text(meal.notes).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func addToGroceries(_ mealIds: [String]) {
        isAddingGroceries = true
        message = nil
        Task {
            do {
                let result = try await model.mutate { try await $0.addMealsToGroceries(mealIds) }
                message = MealSuggestionsView.groceriesSummary(result)
            } catch {
                model.banner = error.localizedDescription
            }
            isAddingGroceries = false
        }
    }

    private func meals(on day: Date) -> [Meal] {
        let key = FamilyDates.dayKey(day)
        let order = (model.state?.allMealCategories ?? []).map(\.id)
        return (model.state?.meals ?? [])
            .filter { $0.day == key }
            .sorted { (order.firstIndex(of: $0.category) ?? order.count) < (order.firstIndex(of: $1.category) ?? order.count) }
    }
}
