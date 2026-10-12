import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(ThemeManager.self) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        @Bindable var theme = theme
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Address", value: model.serverAddress)
                    Button("Change Server") { model.changeServer() }
                    if model.hasSavedSignIn {
                        Button("Forget Sign-In", role: .destructive) {
                            Task { await model.forgetSignIn() }
                        }
                    }
                } header: {
                    Text("Server")
                }

                Section("Appearance") {
                    Picker("Theme", selection: $theme.appearance) {
                        ForEach(Appearance.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                remindersSection

                if let state = model.state {
                    Section {
                        NavigationLink("Household Preferences") { HouseholdPreferencesView(settings: state.settings) }
                        NavigationLink("People") { ProfilesView() }
                        NavigationLink("Photo Frame") { PhotoGalleryView() }
                        NavigationLink("Backup & Restore") { BackupView() }
                    } header: {
                        Text("Household")
                    } footer: {
                        if model.isOffline { Text("Household settings need a connection to the server.") }
                    }
                    .disabled(model.isOffline)

                    ConnectedCalendarsSection(state: state)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.reminders.refreshAuthorization() }
        }
    }

    private var remindersSection: some View {
        let reminders = model.reminders
        let household = HouseholdSettings(values: model.state?.settings ?? [:])
        return Section {
            Toggle("Event and Task Reminders", isOn: Binding(
                get: { reminders.isEnabledOnDevice },
                set: { isOn in
                    Task {
                        if isOn {
                            if await reminders.enable() { await model.refreshReminders() }
                        } else {
                            await reminders.disable()
                        }
                    }
                }
            ))
            if reminders.authorization == .denied {
                Button("Open Notification Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
            }
        } header: {
            Text("This iPhone")
        } footer: {
            if reminders.authorization == .denied {
                Text("Notifications are turned off for Enve Family in the Settings app.")
            } else if !household.remindersEnabled {
                Text("Reminders are turned off for the household in Household Preferences.")
            } else {
                Text("Alerts \(household.reminderMinutes) minutes before timed events and tasks in the loaded calendar weeks, even when the app is closed. Open the app now and then to keep them current.")
            }
        }
    }
}
