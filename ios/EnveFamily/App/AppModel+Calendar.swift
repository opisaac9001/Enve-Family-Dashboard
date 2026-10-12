import Foundation

enum CalendarMode: String, CaseIterable, Identifiable {
    case day, week, agenda

    var id: Self { self }

    var title: String { rawValue.capitalized }
}

struct EventCalendarOption: Identifiable {
    let calendar: EventCalendar
    let name: String

    var id: EventCalendar { calendar }
}

extension AppModel {
    var calendarDays: [Date] {
        switch calendarMode {
        case .day: [FamilyDates.startOfDay(cursor)]
        case .week: days(from: FamilyDates.startOfWeek(cursor), count: 7)
        case .agenda: days(from: FamilyDates.startOfDay(cursor), count: 28)
        }
    }

    var mealWeek: [Date] {
        days(from: FamilyDates.startOfWeek(cursor), count: 7)
    }

    /// One `/api/state` request covers both the calendar view and the meal week, like the web UI (server caps it at 43 days).
    var loadRange: (from: Date, to: Date) {
        let days = calendarDays + mealWeek
        return (days.min()!, FamilyDates.adding(days: 1, to: days.max()!))
    }

    var rangeKey: String {
        let range = loadRange
        return FamilyDates.dayKey(range.from) + "|" + FamilyDates.dayKey(range.to)
    }

    var calendarTitle: String {
        let days = calendarDays
        switch calendarMode {
        case .day:
            return cursor.formatted(.dateTime.weekday(.wide).month(.wide).day())
        case .week, .agenda:
            let last = days.last!
            return "\(days[0].formatted(.dateTime.month(.abbreviated).day())) – \(last.formatted(.dateTime.month(.abbreviated).day()))"
        }
    }

    var newEventDay: Date {
        let today = FamilyDates.startOfDay(.now)
        return calendarDays.contains(today) ? today : calendarDays[0]
    }

    func moveCalendar(by direction: Int) {
        cursor = FamilyDates.adding(days: direction * (calendarMode == .day ? 1 : 7), to: cursor)
    }

    func moveWeek(by direction: Int) {
        cursor = FamilyDates.adding(days: direction * 7, to: cursor)
    }

    func isVisible(profileId: String) -> Bool {
        !hiddenProfiles.contains(profileId)
    }

    func events(on day: Date) -> [CalendarEvent] {
        (state?.events ?? [])
            .filter { isVisible(profileId: $0.profileId) && $0.occurs(on: day) }
            .sorted { $0.allDay != $1.allDay ? $0.allDay : $0.startDate < $1.startDate }
    }

    /// Calendars that accept new events: local, writable Google, and connected iCloud calendars.
    var eventCalendars: [EventCalendarOption] {
        let local = EventCalendarOption(calendar: .local, name: "Enve Family")
        guard let state else { return [local] }
        return [local]
            + state.calendars.filter { $0.enabled && $0.writable == true }.map { EventCalendarOption(calendar: .google(calendarId: $0.id), name: "Google · \($0.name)") }
            + state.icloudCalendars.filter(\.enabled).map { EventCalendarOption(calendar: .icloud(calendarId: $0.id), name: "iCloud · \($0.name)") }
    }

    private func days(from start: Date, count: Int) -> [Date] {
        (0..<count).map { FamilyDates.adding(days: $0, to: start) }
    }
}
