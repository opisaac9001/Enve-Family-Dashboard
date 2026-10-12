import SwiftUI

struct MealCategoriesView: View {
    @Environment(AppModel.self) private var model
    let onComplete: () -> Void

    @State private var categories: [MealCategory]
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(categories: [MealCategory], onComplete: @escaping () -> Void) {
        self.onComplete = onComplete
        _categories = State(initialValue: categories)
    }

    private var validationMessage: String? {
        let names = categories.map { $0.name.trimmingCharacters(in: .whitespaces) }
        if names.contains(where: { $0.isEmpty || $0.count > 30 }) { return "Names need 1 to 30 characters." }
        if Set(names.map { $0.lowercased() }).count != names.count { return "Each meal type needs a different name." }
        if !categories.contains(where: \.enabled) { return "Keep at least one meal type turned on." }
        return nil
    }

    var body: some View {
        Form {
            ForEach($categories) { $category in
                Section {
                    TextField("Name", text: $category.name)
                        .accessibilityLabel("Name for \(category.id)")
                    ColorPicker("Color", selection: Binding(
                        get: { Color(hex: category.color) },
                        set: { category.color = $0.hexString }
                    ), supportsOpacity: false)
                    Toggle("Use When Planning", isOn: $category.enabled)
                } header: {
                    Label {
                        Text(category.name.isEmpty ? category.id : category.name)
                    } icon: {
                        Circle().fill(Color(hex: category.color)).frame(width: 10, height: 10)
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            Section {
                if let validationMessage {
                    Text(validationMessage).foregroundStyle(.red)
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                }
            } footer: {
                Text("Names and colors show on every device. Turned-off types are hidden when planning and suggesting meals; meals already planned keep their type.")
            }
        }
        .disabled(isSaving)
        .navigationTitle("Meal Types")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onComplete)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(validationMessage != nil || isSaving)
            }
        }
    }

    private func save() {
        let categories = categories.map {
            MealCategory(id: $0.id, name: $0.name.trimmingCharacters(in: .whitespaces), color: $0.color.uppercased(), enabled: $0.enabled)
        }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.mutate { try await $0.updateMealCategories(categories) }
                onComplete()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
