import SwiftUI

struct MealEditorView: View {
    @Environment(AppModel.self) private var model
    let week: [Date]
    let editing: Meal?
    /// For an existing repeating meal: only this date, or this date and later.
    let scope: MealScope?
    let onComplete: () -> Void

    @State private var day: Date
    @State private var category: String
    @State private var title: String
    @State private var recipeIds: [String]
    @State private var servings: Int
    @State private var notes: String
    @State private var repeatRule: MealRepeatRule
    @State private var hasRepeatEnd: Bool
    @State private var repeatUntil: Date
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(week: [Date], recipe: Recipe? = nil, servings: Int? = nil, editing: Meal? = nil, scope: MealScope? = nil,
         onComplete: @escaping () -> Void) {
        self.week = week
        self.editing = editing
        self.scope = scope
        self.onComplete = onComplete
        let today = FamilyDates.startOfDay(.now)
        let shownDay = editing.flatMap { FamilyDates.day(fromKey: $0.day) } ?? (week.contains(today) ? today : week[0])
        let until = scope == .series ? editing?.repeatUntil.flatMap(FamilyDates.day(fromKey:)) : nil
        _day = State(initialValue: shownDay)
        _category = State(initialValue: editing?.category ?? "Dinner")
        _title = State(initialValue: editing?.title ?? "")
        _recipeIds = State(initialValue: editing?.recipeIds ?? recipe.map { [$0.id] } ?? [])
        _servings = State(initialValue: editing?.servings ?? servings ?? recipe?.servings ?? 4)
        _notes = State(initialValue: editing?.notes ?? "")
        _repeatRule = State(initialValue: scope == .series ? editing?.repeatRule ?? .none : .none)
        _hasRepeatEnd = State(initialValue: until != nil)
        _repeatUntil = State(initialValue: until ?? shownDay)
    }

    private var showsRepeat: Bool { editing == nil || scope == .series || editing?.isRepeating == false }

    private var recipes: [Recipe] { model.state?.recipes ?? [] }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespaces) }

    /// A meal linked to recipes defaults to their names when the title is left empty.
    private var resolvedTitle: String {
        if !trimmedTitle.isEmpty { return trimmedTitle }
        return recipeIds.compactMap { model.state?.recipe($0)?.title }.joined(separator: " & ")
    }

    private var categoryChoices: [MealCategory] {
        guard let state = model.state else { return MealCategory.defaults }
        let enabled = state.enabledMealCategories
        guard let editing, !enabled.contains(where: { $0.id == editing.category }) else { return enabled }
        return enabled + [state.mealCategory(editing.category)]
    }

    var body: some View {
        Form {
            Section {
                if scope == .series, let editing {
                    let start = FamilyDates.day(fromKey: editing.day)?.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
                    LabeledContent("Starting", value: start ?? editing.day)
                } else if editing != nil {
                    DatePicker("Day", selection: $day, displayedComponents: .date)
                } else {
                    Picker("Day", selection: $day) {
                        ForEach(week, id: \.self) { day in
                            Text(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())).tag(day)
                        }
                    }
                }
                Picker("Meal", selection: $category) {
                    ForEach(categoryChoices) { Text($0.name).tag($0.id) }
                }
                TextField("Title", text: $title, prompt: Text(resolvedTitle.isEmpty ? "What's cooking?" : resolvedTitle))
            }

            recipesSection

            if showsRepeat {
                Section {
                    Picker("Repeat", selection: $repeatRule) {
                        ForEach(MealRepeatRule.allCases) { Text($0.title).tag($0) }
                    }
                    if repeatRule != .none {
                        Toggle("End Repeat", isOn: $hasRepeatEnd)
                        if hasRepeatEnd {
                            DatePicker("End Date", selection: $repeatUntil, in: day..., displayedComponents: .date)
                        }
                    }
                } footer: {
                    if scope == .series {
                        Text("Changes apply to this meal and every later repeat. Earlier dates stay as they are.")
                    }
                }
            }

            Section("Notes") {
                TextField("Notes", text: $notes, axis: .vertical)
                    .lineLimit(2...5)
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(editing == nil ? "Plan Meal" : "Edit Meal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onComplete)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(resolvedTitle.isEmpty || isSaving)
            }
        }
        .onAppear {
            if !categoryChoices.contains(where: { $0.id == category }), let first = categoryChoices.first {
                category = first.id
            }
        }
        .onChange(of: day) {
            if repeatUntil < day { repeatUntil = day }
        }
    }

    private var recipesSection: some View {
        let available = recipes.filter { !recipeIds.contains($0.id) }
        return Section {
            ForEach(recipeIds, id: \.self) { id in
                let name = model.state?.recipe(id)?.title ?? "Deleted recipe"
                HStack {
                    Label(name, systemImage: "book")
                    Spacer()
                    Button {
                        recipeIds.removeAll { $0 == id }
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(name)")
                }
            }
            if recipeIds.count < Meal.maxRecipes, !available.isEmpty {
                Menu {
                    ForEach(available) { recipe in
                        Button(recipe.title) {
                            if recipeIds.isEmpty { servings = recipe.servings }
                            recipeIds.append(recipe.id)
                        }
                    }
                } label: {
                    Label(recipeIds.isEmpty ? "Link a Saved Recipe" : "Link Another Recipe", systemImage: "plus.circle")
                }
            }
            if !recipeIds.isEmpty {
                Stepper("Serves \(servings)", value: $servings, in: 1...24)
            }
        } header: {
            Text("Recipes")
        } footer: {
            if recipeIds.isEmpty {
                Text("Leave empty for a custom meal, or link up to \(Meal.maxRecipes) saved recipes.")
            } else {
                Text("Up to \(Meal.maxRecipes) recipes. All linked recipes add their ingredients, scaled to these servings, to Groceries.")
            }
        }
    }

    private var repeatUntilKey: String? {
        repeatRule != .none && hasRepeatEnd ? FamilyDates.dayKey(repeatUntil) : nil
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        if let editing {
            let update = makeUpdate(from: editing)
            guard !update.isEmpty else {
                onComplete()
                return
            }
            let id = editing.id
            let scope = scope
            Task {
                do {
                    try await model.mutate { try await $0.updateMeal(id, update, scope: scope) }
                    onComplete()
                } catch {
                    errorMessage = error.localizedDescription
                }
                isSaving = false
            }
        } else {
            let payload = MealPayload(
                day: FamilyDates.dayKey(day), category: category, title: resolvedTitle, notes: notes,
                recipeId: nil, servings: recipeIds.isEmpty ? nil : servings, recipeIds: recipeIds,
                repeatRule: repeatRule.rawValue, repeatUntil: repeatUntilKey
            )
            Task {
                do {
                    try await model.create(.meal(payload))
                    onComplete()
                } catch {
                    errorMessage = error.localizedDescription
                }
                isSaving = false
            }
        }
    }

    private func makeUpdate(from meal: Meal) -> MealUpdate {
        var update = MealUpdate()
        if scope != .series, FamilyDates.dayKey(day) != meal.day { update.day = FamilyDates.dayKey(day) }
        if category != meal.category { update.category = category }
        if resolvedTitle != meal.title { update.title = resolvedTitle }
        if notes != meal.notes { update.notes = notes }
        if recipeIds != meal.recipeIds { update.recipeIds = recipeIds }
        if !recipeIds.isEmpty, servings != meal.servings { update.servings = servings }
        if scope == .series || !meal.isRepeating {
            if repeatRule != meal.repeatRule { update.repeatRule = repeatRule.rawValue }
            if repeatUntilKey != meal.repeatUntil { update.repeatUntil = .some(repeatUntilKey) }
        }
        return update
    }
}
