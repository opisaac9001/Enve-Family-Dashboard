import Foundation

/// Typed view over the server's string-valued `settings` map.
struct HouseholdSettings: Sendable {
    static let lightAtKey = "light_at"
    static let darkAtKey = "dark_at"
    static let remindersEnabledKey = "reminders_enabled"
    static let reminderMinutesKey = "reminder_minutes"
    static let weatherCityKey = "weather_city"
    static let weatherUnitsKey = "weather_units"
    static let defaultReminderMinutes = 15

    let values: [String: String]

    var remindersEnabled: Bool {
        values[Self.remindersEnabledKey].map { !["0", "false", "off", "no"].contains($0.lowercased()) } ?? true
    }

    var reminderMinutes: Int {
        values[Self.reminderMinutesKey].flatMap { Int($0) }.map { max($0, 0) } ?? Self.defaultReminderMinutes
    }

    /// Writes a boolean in the same vocabulary the server already uses for the key.
    func encode(_ value: Bool, for key: String) -> String {
        switch values[key] {
        case "0", "1": value ? "1" : "0"
        default: value ? "true" : "false"
        }
    }
}
