import SwiftUI

struct ConnectedCalendarsSection: View {
    let state: FamilyState

    var body: some View {
        let providers = [
            Provider(name: "Google", accounts: state.accounts, calendars: state.calendars),
            Provider(name: "Outlook", accounts: state.outlookAccounts, calendars: state.outlookCalendars),
            Provider(name: "iCloud", accounts: state.icloudAccounts, calendars: state.icloudCalendars),
        ]
        let hasAccounts = providers.contains { !$0.accounts.isEmpty } || !state.feedCalendars.isEmpty

        Section {
            if !hasAccounts {
                Text("No calendars connected.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Connected Calendars")
        } footer: {
            Text("Connect and manage calendar accounts from the dashboard on the server computer.")
        }

        ForEach(providers) { provider in
            ForEach(provider.accounts) { account in
                Section {
                    LabeledContent("Person") { ProfileLabel(profile: state.profile(account.profileId)) }
                    ForEach(provider.calendars.filter { $0.accountId == account.id }) { calendar in
                        LabeledContent(calendar.name, value: calendarStatus(calendar))
                    }
                } header: {
                    Text("\(provider.name) · \(account.email)")
                }
            }
        }

        if !state.feedCalendars.isEmpty {
            Section("Subscribed Calendars") {
                ForEach(state.feedCalendars) { feed in
                    LabeledContent(feed.name, value: "\(state.profile(feed.profileId)?.name ?? "") · \(feed.enabled ? "Shown" : "Hidden")")
                }
            }
        }

        if !state.syncFailures.isEmpty {
            Section("Sync Issues") {
                ForEach(state.syncFailures, id: \.self) { failure in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(failure.calendar)
                        Text(failure.message).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func calendarStatus(_ calendar: ConnectedCalendar) -> String {
        guard calendar.enabled else { return "Hidden" }
        return calendar.writable == true ? "Shown · Editable" : "Shown"
    }
}

private struct Provider: Identifiable {
    let name: String
    let accounts: [CalendarAccount]
    let calendars: [ConnectedCalendar]

    var id: String { name }
}
