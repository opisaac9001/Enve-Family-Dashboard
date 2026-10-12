import SwiftUI

struct EventEditorView: View {
    private static let repeatRules = ["none", "daily", "weekly", "monthly", "yearly"]

    @Environment(AppModel.self) private var model
    let editing: CalendarEvent?
    let scope: EventScope
    let onSave: () -> Void
    let onComplete: () -> Void

    @State private var title: String
    @State private var profileId: String
    @State private var calendar: EventCalendar = .local
    @State private var allDay: Bool
    @State private var start: Date
    /// For all-day events this is the inclusive last day; the server's end date is exclusive.
    @State private var end: Date
    @State private var notes: String
    @State private var repeatRule: String
    @State private var hasRepeatEnd: Bool
    @State private var repeatUntil: Date
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(editing: CalendarEvent?, scope: EventScope, day: Date, draft: EventDraft? = nil,
         onSave: @escaping () -> Void = {}, onComplete: @escaping () -> Void) {
        self.editing = editing
        self.scope = scope
        self.onSave = onSave
        self.onComplete = onComplete

        var shownStart = FamilyDates.calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
        var shownEnd = shownStart.addingTimeInterval(3600)
        var shownAllDay = false
        if let editing {
            if scope == .series, let seriesStart = editing.seriesStart, let seriesEnd = editing.seriesEnd,
               let startDate = FamilyDates.eventDate(seriesStart), let endDate = FamilyDates.eventDate(seriesEnd) {
                (shownStart, shownEnd, shownAllDay) = (startDate, endDate, FamilyDates.isDayKey(seriesStart))
            } else {
                (shownStart, shownEnd, shownAllDay) = (editing.startDate, editing.endDate, editing.allDay)
            }
        } else if let draft {
            (shownStart, shownEnd, shownAllDay) = (draft.start, max(draft.end, draft.start), draft.allDay)
        }
        if shownAllDay { shownEnd = max(FamilyDates.adding(days: -1, to: shownEnd), shownStart) }
        let rule = scope == .series ? editing?.repeatRule ?? draft?.repeatRule ?? "none" : "none"
        let until = scope == .series ? editing?.repeatUntil.flatMap(FamilyDates.day(fromKey:)) : nil

        _title = State(initialValue: editing?.title ?? draft?.title ?? "")
        _profileId = State(initialValue: editing?.profileId ?? "family")
        _allDay = State(initialValue: shownAllDay)
        _start = State(initialValue: shownStart)
        _end = State(initialValue: shownEnd)
        _notes = State(initialValue: editing?.notes ?? draft?.notes ?? "")
        _repeatRule = State(initialValue: rule)
        _hasRepeatEnd = State(initialValue: until != nil)
        _repeatUntil = State(initialValue: until ?? shownStart)
    }

    private var showsRepeat: Bool {
        guard scope == .series else { return false }
        if let editing { return editing.source == .local }
        return calendar == .local
    }

    var body: some View {
        let components: DatePickerComponents = allDay ? .date : [.date, .hourAndMinute]
        Form {
            Section {
                TextField("Title", text: $title)
                ProfilePicker(selection: $profileId)
                if let editing {
                    LabeledContent("Calendar", value: editing.calendarName ?? editing.source.title)
                } else {
                    Picker("Calendar", selection: $calendar) {
                        ForEach(model.eventCalendars) { option in
                            Text(option.name).tag(option.calendar)
                        }
                    }
                }
            }

            Section {
                Toggle("All day", isOn: $allDay)
                DatePicker("Starts", selection: $start, displayedComponents: components)
                DatePicker("Ends", selection: $end, in: start..., displayedComponents: components)
            }

            if showsRepeat {
                Section {
                    Picker("Repeat", selection: $repeatRule) {
                        ForEach(Self.repeatRules, id: \.self) { rule in
                            Text(rule == "none" ? "Never" : rule.capitalized).tag(rule)
                        }
                    }
                    if repeatRule != "none" {
                        Toggle("End repeat", isOn: $hasRepeatEnd)
                        if hasRepeatEnd {
                            DatePicker("End date", selection: $repeatUntil, in: start..., displayedComponents: .date)
                        }
                    }
                }
            }

            Section("Notes") {
                TextField("Notes", text: $notes, axis: .vertical)
                    .lineLimit(3...8)
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(editing == nil ? "New Event" : "Edit Event")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if editing == nil {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onComplete)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
            }
        }
        .onChange(of: start) {
            if end < start { end = allDay ? start : start.addingTimeInterval(3600) }
        }
    }

    private func makePayload() -> EventPayload {
        let startValue: String
        let endValue: String
        let localStart: String
        let localEnd: String
        if allDay {
            startValue = FamilyDates.dayKey(start)
            endValue = FamilyDates.dayKey(FamilyDates.adding(days: 1, to: end))
            (localStart, localEnd) = (startValue, endValue)
        } else {
            // recurrence.js requires the instant and wall-clock values to agree exactly, so drop seconds first.
            let startMinute = FamilyDates.truncatedToMinute(start)
            let endMinute = FamilyDates.truncatedToMinute(end)
            startValue = FamilyDates.isoString(startMinute)
            endValue = FamilyDates.isoString(endMinute)
            localStart = FamilyDates.localDateTime(startMinute)
            localEnd = FamilyDates.localDateTime(endMinute)
        }
        let rule = showsRepeat ? repeatRule : "none"
        return EventPayload(
            title: title.trimmingCharacters(in: .whitespaces),
            profileId: profileId,
            allDay: allDay,
            start: startValue,
            end: endValue,
            notes: notes,
            localStart: localStart,
            localEnd: localEnd,
            timeZone: TimeZone.current.identifier,
            repeatRule: rule,
            repeatUntil: rule != "none" && hasRepeatEnd ? FamilyDates.dayKey(repeatUntil) : nil
        )
    }

    private func save() {
        let payload = makePayload()
        let location = editing?.location
        let calendar = calendar
        let scope = scope
        isSaving = true
        errorMessage = nil
        Task {
            do {
                if let location {
                    try await model.mutate { try await $0.updateEvent(at: location, payload: payload, scope: scope) }
                } else if calendar == .local {
                    try await model.create(.event(payload))
                } else {
                    try await model.mutate { try await $0.createEvent(payload, in: calendar) }
                }
                onSave()
                onComplete()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
