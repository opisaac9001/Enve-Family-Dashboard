import SwiftUI

struct MealSuggestionsView: View {
    private enum Source: String, CaseIterable, Identifiable {
        case saved, builtin, cloud

        var id: Self { self }

        var title: String {
            switch self {
            case .saved: "Saved"
            case .builtin: "Built-in"
            case .cloud: "Cloud"
            }
        }

        var ideaSource: MealIdeaSource? {
            switch self {
            case .saved: nil
            case .builtin: .builtin
            case .cloud: .cloud
            }
        }
    }

    private struct Draft: Identifiable {
        let suggestion: MealSuggestion
        var include = true
        var recipeId: String?
        var draftRecipe: DraftRecipe?
        var servings: Int
        var notes = ""

        var id: String { suggestion.day + ":" + suggestion.category }

        init(_ suggestion: MealSuggestion) {
            self.suggestion = suggestion
            recipeId = suggestion.recipeId
            draftRecipe = suggestion.draftRecipe
            servings = suggestion.servings
        }

        var isUnchanged: Bool { recipeId == suggestion.recipeId && servings == suggestion.servings }

        var isComplete: Bool {
            guard let draftRecipe else { return recipeId != nil }
            return !draftRecipe.title.trimmingCharacters(in: .whitespaces).isEmpty
                && !draftRecipe.ingredients.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private static let cloudSlotLimit = 14

    @Environment(AppModel.self) private var model
    let week: [Date]
    let onSaved: (String) -> Void
    let onComplete: () -> Void

    @State private var source = Source.saved
    @State private var startDay: Date
    @State private var categories: Set<String> = ["Dinner"]
    @State private var servings = 4
    @State private var avoid = ""
    @State private var avoidTerms: [String] = []
    @State private var drafts: [Draft]?
    @State private var addToGroceries = false
    @State private var errorMessage: String?
    @State private var isWorking = false

    init(week: [Date], onSaved: @escaping (String) -> Void, onComplete: @escaping () -> Void) {
        self.week = week
        self.onSaved = onSaved
        self.onComplete = onComplete
        let today = FamilyDates.startOfDay(.now)
        _startDay = State(initialValue: week.contains(today) ? today : week[0])
    }

    var body: some View {
        Form {
            if let drafts {
                review(drafts)
            } else {
                options
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                    if drafts != nil {
                        Button("Suggest Again", action: suggest)
                    }
                }
            }
        }
        .disabled(isWorking)
        .navigationTitle(drafts == nil ? "Suggest Meals" : "Review Meals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onComplete)
            }
            ToolbarItem(placement: .confirmationAction) {
                if let drafts {
                    let included = drafts.filter(\.include)
                    Button("Add \(included.count)", action: save)
                        .disabled(included.isEmpty || !included.allSatisfy(\.isComplete) || isWorking)
                } else if isWorking {
                    ProgressView()
                } else {
                    Button("Suggest", action: suggest)
                        .disabled(!canSuggest)
                }
            }
        }
        .onAppear {
            let enabled = enabledCategories.map(\.id)
            categories.formIntersection(enabled)
            if categories.isEmpty, let first = enabled.first { categories = [first] }
        }
    }

    private var recipes: [Recipe] { model.state?.recipes ?? [] }

    private var enabledCategories: [MealCategory] { model.state?.enabledMealCategories ?? MealCategory.defaults }

    private var sources: [Source] {
        model.state?.canUseCloudMealIdeas == true ? Source.allCases : [.saved, .builtin]
    }

    /// Slots in the seven days that have no meal in the loaded plan. Days outside the loaded range count as open.
    private var openSlotCount: Int {
        let filled = Set((model.state?.meals ?? []).map { $0.day + ":" + $0.category })
        return (0..<7).reduce(0) { count, offset in
            let day = FamilyDates.dayKey(FamilyDates.adding(days: offset, to: startDay))
            return count + categories.filter { !filled.contains(day + ":" + $0) }.count
        }
    }

    private var canSuggest: Bool {
        guard !categories.isEmpty else { return false }
        switch source {
        case .saved: return !recipes.isEmpty
        case .builtin: return true
        case .cloud: return openSlotCount <= Self.cloudSlotLimit
        }
    }

    @ViewBuilder
    private var options: some View {
        Section {
            Picker("Source", selection: $source) {
                ForEach(sources) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
        } footer: {
            sourceFooter
        }

        Section {
            Picker("Starting", selection: $startDay) {
                ForEach(week, id: \.self) { day in
                    Text(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())).tag(day)
                }
            }
            Stepper("Serves \(servings)", value: $servings, in: 1...24)
        } footer: {
            Text("Covers seven days from this day. Meals that are already planned stay as they are.")
        }

        Section {
            ForEach(enabledCategories) { category in
                Toggle(isOn: Binding(
                    get: { categories.contains(category.id) },
                    set: { if $0 { categories.insert(category.id) } else { categories.remove(category.id) } }
                )) {
                    Label {
                        Text(category.name)
                    } icon: {
                        Circle().fill(Color(hex: category.color)).frame(width: 10, height: 10)
                    }
                }
            }
        } header: {
            Text("Meals")
        } footer: {
            if source == .cloud, openSlotCount > Self.cloudSlotLimit {
                Text("Cloud ideas cover up to \(Self.cloudSlotLimit) open meals at once, and these choices leave up to \(openSlotCount). Choose fewer meal types or a later starting day.")
                    .foregroundStyle(.red)
            }
        }

        Section {
            TextField("e.g. peanut, shrimp", text: $avoid)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Words to leave out")
        } header: {
            Text("Leave Out")
        } footer: {
            avoidFooter
        }
    }

    private var sourceFooter: Text {
        switch source {
        case .saved:
            recipes.isEmpty
                ? Text("Saved suggestions only use recipes in the Recipe Box, and it's empty. Save a few family favorites first, or try Built-in.")
                : Text("Picks from recipes in your Recipe Box.")
        case .builtin:
            Text("Ideas from a list built into the server. Nothing is sent outside your home server. Each idea comes with a draft recipe you can edit; it's saved to the Recipe Box only if you add the meal.")
        case .cloud:
            Text("Your server sends the chosen days, meal types, servings, and words to leave out to OpenAI to write ideas. Each idea comes with a draft recipe you can edit; it's saved to the Recipe Box only if you add the meal.")
        }
    }

    private var avoidFooter: Text {
        switch source {
        case .saved:
            Text("Separate words with commas. Recipes whose name or ingredients contain these words are skipped. This is simple text matching, not an allergy check — always read the recipe.")
        case .builtin:
            Text("Separate words with commas. Ideas whose name or ingredients contain these words are skipped. This is simple text matching, not an allergy check — always read the ingredients.")
        case .cloud:
            Text("Separate words with commas. These words are sent with the request so ideas avoid them, but AI-written recipes can still include them. This is not an allergy check — always read the ingredients.")
        }
    }

    @ViewBuilder
    private func review(_ drafts: [Draft]) -> some View {
        if drafts.isEmpty {
            Section {
                ContentUnavailableView("No Open Spots", systemImage: "fork.knife",
                                       description: Text("Every chosen meal already has something planned for these seven days, or nothing matched."))
            }
        }

        ForEach(drafts) { draftSection($0) }

        if !drafts.isEmpty {
            Section {
                Toggle("Add Ingredients to Groceries", isOn: $addToGroceries)
            } footer: {
                Text("Matching amounts are combined, and items already on the list are updated instead of added twice.")
            }
        }

        Section {
            Button("Change Options") {
                self.drafts = nil
                errorMessage = nil
            }
        }
    }

    private func draftSection(_ draft: Draft) -> some View {
        let binding = Binding(
            get: { drafts?.first { $0.id == draft.id } ?? draft },
            set: { value in
                if let index = drafts?.firstIndex(where: { $0.id == value.id }) { drafts?[index] = value }
            }
        )
        let slot = slotTitle(draft.suggestion)
        return Section {
            Toggle("Include", isOn: binding.include)
                .accessibilityLabel("Include \(slot)")
            Group {
                if let recipe = Binding(binding.draftRecipe) {
                    labeledField("Recipe Name", text: recipe.title, lines: 1...2)
                    labeledField("Ingredients, One per Line", text: recipe.ingredients, lines: 3...12)
                    labeledField("Directions", text: recipe.directions, lines: 2...10)
                } else {
                    Picker("Recipe", selection: binding.recipeId) {
                        ForEach(choices(keeping: draft.recipeId)) { Text($0.title).tag(Optional($0.id)) }
                    }
                }
                Stepper("Serves \(draft.servings)", value: binding.servings, in: 1...24)
                TextField("Notes (optional)", text: binding.notes, axis: .vertical)
                    .lineLimit(1...4)
                if draft.draftRecipe == nil, draft.isUnchanged, !draft.suggestion.ingredients.isEmpty {
                    DisclosureGroup("Ingredients (\(draft.suggestion.ingredients.count))") {
                        ForEach(Array(draft.suggestion.ingredients.enumerated()), id: \.offset) { _, line in
                            Text(line).font(.subheadline)
                        }
                    }
                }
            }
            .disabled(!draft.include)
        } header: {
            Text(slot)
                .foregroundStyle(draft.include ? Color(hex: model.state?.mealCategory(draft.suggestion.category).color ?? "#F5921A") : Color.secondary)
        } footer: {
            if draft.include, !draft.isComplete {
                Text("Add a recipe name and at least one ingredient, or turn this meal off.")
            }
        }
    }

    private func labeledField(_ label: String, text: Binding<String>, lines: ClosedRange<Int>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(label, text: text, axis: .vertical)
                .lineLimit(lines)
        }
    }

    private func slotTitle(_ suggestion: MealSuggestion) -> String {
        let day = FamilyDates.day(fromKey: suggestion.day)?.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()) ?? suggestion.day
        let category = model.state?.mealCategory(suggestion.category).name ?? suggestion.category
        return "\(day) · \(category)"
    }

    /// Mirrors the server's literal exclusion matching so swapped recipes respect the same words.
    private func choices(keeping recipeId: String?) -> [Recipe] {
        recipes.filter { recipe in
            recipe.id == recipeId || avoidTerms.allSatisfy { !"\(recipe.title)\n\(recipe.ingredients)".lowercased().contains($0) }
        }
    }

    private func suggest() {
        let request = MealSuggestionRequest(
            startDay: FamilyDates.dayKey(startDay),
            categories: enabledCategories.map(\.id).filter { categories.contains($0) },
            servings: servings,
            avoid: avoid,
            source: source.ideaSource
        )
        let terms = avoid.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        isWorking = true
        errorMessage = nil
        Task {
            do {
                let suggestions = try await model.call { try await $0.suggestMeals(request) }
                avoidTerms = terms
                drafts = suggestions.map(Draft.init)
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func save() {
        let meals = (drafts ?? []).filter(\.include).map { draft in
            PlannedMealPayload(
                day: draft.suggestion.day, category: draft.suggestion.category, servings: draft.servings,
                notes: draft.notes.trimmingCharacters(in: .whitespacesAndNewlines),
                recipeId: draft.draftRecipe == nil ? draft.recipeId : nil,
                draftRecipe: draft.draftRecipe.map {
                    var recipe = $0
                    recipe.title = recipe.title.trimmingCharacters(in: .whitespaces)
                    return recipe
                }
            )
        }
        let addGroceries = addToGroceries
        isWorking = true
        errorMessage = nil
        Task {
            defer { isWorking = false }
            let result: PlanResult
            do {
                result = try await model.callUnlocked { try await $0.planMeals(meals) }
            } catch {
                errorMessage = error.localizedDescription
                return
            }
            var summary = result.ids.count == 1 ? "Planned 1 meal." : "Planned \(result.ids.count) meals."
            switch result.createdRecipeIds.count {
            case 0: break
            case 1: summary += " Saved 1 new recipe."
            case let count: summary += " Saved \(count) new recipes."
            }
            if addGroceries {
                do {
                    let ids = result.ids
                    let groceries = try await model.callUnlocked { try await $0.addMealsToGroceries(ids) }
                    summary += " " + Self.groceriesSummary(groceries)
                } catch {
                    summary += " Groceries weren't updated: \(error.localizedDescription)"
                }
            }
            await model.load()
            onSaved(summary)
            onComplete()
        }
    }

    static func groceriesSummary(_ result: GroceryResult) -> String {
        func items(_ count: Int) -> String { count == 1 ? "1 item" : "\(count) items" }
        return switch (result.added, result.updated) {
        case (0, 0): "Groceries already had every ingredient."
        case (let added, 0): "Added \(items(added)) to Groceries."
        case (0, let updated): "Updated \(items(updated)) on Groceries."
        case (let added, let updated): "Added \(items(added)) and updated \(items(updated)) on Groceries."
        }
    }
}
