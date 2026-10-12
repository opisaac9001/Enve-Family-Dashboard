import Foundation

enum FamilyDates {
    private static let instantStyles: [Date.ISO8601FormatStyle] = [
        Date.ISO8601FormatStyle(includingFractionalSeconds: true),
        Date.ISO8601FormatStyle(),
        Date.ISO8601FormatStyle(timeZoneSeparator: .colon, includingFractionalSeconds: true),
        Date.ISO8601FormatStyle(timeZoneSeparator: .colon),
    ]

    static var calendar: Calendar { .current }

    /// `yyyy-MM-dd` in the device's calendar, matching the web UI's `dateKey`.
    static func dayKey(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    static func day(fromKey key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func isDayKey(_ value: String) -> Bool {
        value.count == 10
    }

    static func instant(_ value: String) -> Date? {
        for style in instantStyles {
            if let date = try? style.parse(value) { return date }
        }
        return nil
    }

    /// Server event boundaries are either all-day keys or ISO instants.
    static func eventDate(_ value: String) -> Date? {
        isDayKey(value) ? day(fromKey: value) : instant(value)
    }

    static func isoString(_ date: Date) -> String {
        instantStyles[0].format(date)
    }

    /// Wall-clock `yyyy-MM-ddTHH:mm`, the form recurrence.js expects for `localStart`/`localEnd`.
    static func localDateTime(_ date: Date) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return "\(dayKey(date))T" + String(format: "%02d:%02d", parts.hour!, parts.minute!)
    }

    static func timeKey(_ date: Date) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour!, parts.minute!)
    }

    static func time(fromKey key: String, on day: Date) -> Date? {
        let parts = key.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: day)
    }

    static func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    static func startOfWeek(_ date: Date) -> Date {
        calendar.dateInterval(of: .weekOfYear, for: date)!.start
    }

    static func adding(days: Int, to date: Date) -> Date {
        calendar.date(byAdding: .day, value: days, to: date)!
    }

    static func truncatedToMinute(_ date: Date) -> Date {
        calendar.dateInterval(of: .minute, for: date)!.start
    }
}
