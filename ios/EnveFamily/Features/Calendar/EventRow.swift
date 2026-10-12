import SwiftUI

struct EventRow: View {
    @Environment(AppModel.self) private var model
    let event: CalendarEvent

    var body: some View {
        let profile = model.state?.profile(event.profileId)
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 2)
                .fill(event.indicatorColor(profile: profile))
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.body.weight(.medium))
                Text([event.timeSummary, profile?.name, event.calendarName].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

extension CalendarEvent {
    func indicatorColor(profile: Profile?) -> Color {
        Color(hex: color ?? profile?.color ?? "#F5921A")
    }

    var timeSummary: String {
        allDay ? "All day" : "\(startDate.formatted(date: .omitted, time: .shortened)) – \(endDate.formatted(date: .omitted, time: .shortened))"
    }

    var fullTimeDescription: String {
        if allDay {
            let lastDay = FamilyDates.adding(days: -1, to: endDate)
            let first = startDate.formatted(date: .abbreviated, time: .omitted)
            return lastDay > startDate ? "\(first) – \(lastDay.formatted(date: .abbreviated, time: .omitted)) · All day" : "\(first) · All day"
        }
        let sameDay = Calendar.current.isDate(startDate, inSameDayAs: endDate)
        let end = sameDay ? endDate.formatted(date: .omitted, time: .shortened) : endDate.formatted(date: .abbreviated, time: .shortened)
        return "\(startDate.formatted(date: .abbreviated, time: .shortened)) – \(end)"
    }
}
