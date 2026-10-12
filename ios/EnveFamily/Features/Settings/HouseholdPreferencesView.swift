import SwiftUI

/// Household-wide display, reminder, and weather settings stored on the server.
struct HouseholdPreferencesView: View {
    private static let reminderChoices = [0, 5, 10, 15, 30, 60, 120]
    private static let units = ["fahrenheit", "celsius"]
    private static let accentChoices = [("Orange", "#F5921A"), ("Mint", "#62C9AC"),
                                        ("Blue", "#8DBBF1"), ("Lilac", "#C0A6F1"), ("Rose", "#F2A6B6")]

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    private let original: HouseholdSettings

    @State private var lightAt: Date
    @State private var darkAt: Date
    @State private var accentColor: String
    @State private var remindersEnabled: Bool
    @State private var reminderMinutes: Int
    @State private var weatherCity: String
    @State private var weatherUnits: String
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(settings: [String: String]) {
        let original = HouseholdSettings(values: settings)
        self.original = original
        let today = FamilyDates.startOfDay(.now)
        _lightAt = State(initialValue: settings[HouseholdSettings.lightAtKey].flatMap { FamilyDates.time(fromKey: $0, on: today) }
            ?? FamilyDates.time(fromKey: "07:00", on: today)!)
        _darkAt = State(initialValue: settings[HouseholdSettings.darkAtKey].flatMap { FamilyDates.time(fromKey: $0, on: today) }
            ?? FamilyDates.time(fromKey: "19:00", on: today)!)
        _accentColor = State(initialValue: settings["accent_color"] ?? "#F5921A")
        _remindersEnabled = State(initialValue: original.remindersEnabled)
        _reminderMinutes = State(initialValue: original.reminderMinutes)
        _weatherCity = State(initialValue: settings[HouseholdSettings.weatherCityKey] ?? "")
        _weatherUnits = State(initialValue: settings[HouseholdSettings.weatherUnitsKey] ?? Self.units[0])
    }

    var body: some View {
        Form {
            Section {
                DatePicker("Light from", selection: $lightAt, displayedComponents: .hourAndMinute)
                DatePicker("Dark from", selection: $darkAt, displayedComponents: .hourAndMinute)
            } header: {
                Text("Schedule Theme")
            } footer: {
                Text("Used by the Schedule theme on every screen, including this iPhone.")
            }

            Section("Accent color") {
                Picker("Color", selection: $accentColor) {
                    ForEach(Self.accentChoices.indices, id: \.self) { index in
                        HStack {
                            Circle()
                                .fill(Color(hex: Self.accentChoices[index].1))
                                .frame(width: 18, height: 18)
                            Text(Self.accentChoices[index].0)
                        }
                        .tag(Self.accentChoices[index].1)
                    }
                }
            }

            Section {
                Toggle("Reminders", isOn: $remindersEnabled)
                if remindersEnabled {
                    Picker("Remind", selection: $reminderMinutes) {
                        ForEach(reminderOptions, id: \.self) { minutes in
                            Text(minutes == 0 ? "At start time" : "\(minutes) minutes before").tag(minutes)
                        }
                    }
                }
            } header: {
                Text("Reminders")
            } footer: {
                Text("Applies to the whole household. Each iPhone also turns reminders on for itself in Settings.")
            }

            Section("Weather") {
                TextField("City", text: $weatherCity)
                    .textContentType(.addressCity)
                Picker("Units", selection: $weatherUnits) {
                    ForEach(unitOptions, id: \.self) { Text($0.capitalized).tag($0) }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Household Preferences")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(changes.isEmpty || isSaving)
            }
        }
    }

    private var reminderOptions: [Int] {
        Self.reminderChoices.contains(original.reminderMinutes) ? Self.reminderChoices : (Self.reminderChoices + [original.reminderMinutes]).sorted()
    }

    /// Keeps a unit value the server already has even if it isn't one of the usual choices.
    private var unitOptions: [String] {
        Self.units.contains(weatherUnits) ? Self.units : Self.units + [weatherUnits]
    }

    private var changes: [String: String] {
        let edited: [String: String] = [
            HouseholdSettings.lightAtKey: FamilyDates.timeKey(lightAt),
            HouseholdSettings.darkAtKey: FamilyDates.timeKey(darkAt),
            "accent_color": accentColor,
            HouseholdSettings.remindersEnabledKey: original.encode(remindersEnabled, for: HouseholdSettings.remindersEnabledKey),
            HouseholdSettings.reminderMinutesKey: String(reminderMinutes),
            HouseholdSettings.weatherCityKey: weatherCity.trimmingCharacters(in: .whitespaces),
            HouseholdSettings.weatherUnitsKey: weatherUnits,
        ]
        return edited.filter { key, value in original.values[key] != value && !(original.values[key] == nil && isDefault(key, value)) }
    }

    /// Values the form shows for keys the server hasn't stored yet, so opening and saving doesn't write them.
    private func isDefault(_ key: String, _ value: String) -> Bool {
        switch key {
        case HouseholdSettings.lightAtKey: value == "07:00"
        case HouseholdSettings.darkAtKey: value == "19:00"
        case "accent_color": value == "#F5921A"
        case HouseholdSettings.remindersEnabledKey: remindersEnabled
        case HouseholdSettings.reminderMinutesKey: value == String(HouseholdSettings.defaultReminderMinutes)
        case HouseholdSettings.weatherCityKey: value.isEmpty
        case HouseholdSettings.weatherUnitsKey: value == Self.units[0]
        default: false
        }
    }

    private func save() {
        let changes = changes
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.mutate { try await $0.updateSettings(changes) }
                await model.refreshReminders()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
