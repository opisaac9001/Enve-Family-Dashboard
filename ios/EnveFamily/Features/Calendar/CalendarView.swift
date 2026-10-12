import SwiftUI

struct CalendarView: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model
    @State private var selectedEvent: CalendarEvent?
    @State private var isCreating = false
    @State private var isSearching = false
    @State private var searchSelection: SearchHit?
    @State private var weather: WeatherReport?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            List {
                if let weather {
                    Section { WeatherRow(report: weather) }
                }

                Section {
                    Picker("View", selection: $model.calendarMode) {
                        ForEach(CalendarMode.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    HStack {
                        Button { model.moveCalendar(by: -1) } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("Previous")
                        Spacer()
                        Text(model.calendarTitle).font(.headline)
                        Spacer()
                        Button { model.moveCalendar(by: 1) } label: { Image(systemName: "chevron.right") }
                            .accessibilityLabel("Next")
                    }
                    .buttonStyle(.borderless)
                    ProfileFilterBar()
                }
                .listRowSeparator(.hidden)

                let sharedCount = model.pendingShares.count + model.unreadableShareIDs.count
                if sharedCount > 0 {
                    Section {
                        Button { model.isShowingImport = true } label: {
                            Label("\(sharedCount) shared item\(sharedCount == 1 ? "" : "s") to review", systemImage: "square.and.arrow.down")
                        }
                    }
                }

                if let failures = model.state?.syncFailures, !failures.isEmpty {
                    Section {
                        ForEach(failures, id: \.self) { failure in
                            Label("\(failure.calendar): \(failure.message)", systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(accent)
                        }
                    }
                }

                daySections
            }
            .refreshable {
                await model.load()
                await loadWeather()
            }
            .task(id: weatherSettings) { await loadWeather() }
            .navigationTitle("Calendar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SettingsButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Today") { model.cursor = .now }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { isSearching = true } label: { Image(systemName: "magnifyingglass") }
                        .accessibilityLabel("Search")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.isShowingImport = true } label: { Image(systemName: "doc.viewfinder") }
                        .accessibilityLabel("Import")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { isCreating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New Event")
                }
            }
            .sheet(isPresented: $isSearching, onDismiss: showSearchSelection) {
                CalendarSearchView { hit in
                    searchSelection = hit
                    isSearching = false
                }
                .pinPromptHost(level: 1)
            }
            .sheet(item: $selectedEvent) { event in
                EventDetailView(event: event)
                    .pinPromptHost(level: 1)
            }
            .sheet(isPresented: $isCreating) {
                NavigationStack {
                    EventEditorView(editing: nil, scope: .series, day: model.newEventDay) { isCreating = false }
                }
                .pinPromptHost(level: 1)
            }
        }
    }

    private var weatherSettings: String {
        let settings = model.state?.settings ?? [:]
        return [HouseholdSettings.weatherCityKey, HouseholdSettings.weatherUnitsKey].map { settings[$0] ?? "" }.joined(separator: "|")
    }

    private func loadWeather() async {
        weather = (try? await model.call { try await $0.weather() }).flatMap(WeatherReport.init)
    }

    /// Moves the calendar to the chosen result's day and opens the event once that range has loaded.
    private func showSearchSelection() {
        guard let hit = searchSelection, let date = hit.date else { return }
        searchSelection = nil
        if model.calendarMode == .agenda { model.calendarMode = .week }
        model.cursor = date
        Task {
            await model.load()
            guard hit.isEvent else { return }
            let sameDay = (model.state?.events ?? []).filter { FamilyDates.calendar.isDate($0.startDate, inSameDayAs: date) }
            selectedEvent = sameDay.first { $0.id == hit.itemId || ($0.seriesId != nil && $0.seriesId == hit.itemId) }
                ?? sameDay.first { $0.title == hit.title }
        }
    }

    @ViewBuilder
    private var daySections: some View {
        let days = model.calendarDays.map { DayEvents(day: $0, events: model.events(on: $0)) }
        let shown = model.calendarMode == .agenda ? days.filter { !$0.events.isEmpty } : days
        if shown.isEmpty {
            ContentUnavailableView("Nothing Scheduled", systemImage: "calendar", description: Text("No events in these four weeks."))
        }
        ForEach(shown) { entry in
            Section {
                if entry.events.isEmpty {
                    Text("A little breathing room").foregroundStyle(.secondary)
                }
                ForEach(entry.events) { event in
                    Button { selectedEvent = event } label: { EventRow(event: event) }
                        .buttonStyle(.plain)
                }
            } header: {
                Text(entry.day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                    .foregroundStyle(Calendar.current.isDateInToday(entry.day) ? accent : Color.secondary)
            }
        }
    }
}

private struct DayEvents: Identifiable {
    let day: Date
    let events: [CalendarEvent]

    var id: Date { day }
}
