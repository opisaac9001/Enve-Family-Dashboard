import Foundation

struct CalendarEvent: Decodable, Identifiable, Hashable, Sendable {
    enum Source: String, Decodable, Sendable {
        case local, google, outlook, icloud, feed

        var title: String {
            switch self {
            case .local: "Enve Family"
            case .google: "Google"
            case .outlook: "Outlook"
            case .icloud: "iCloud"
            case .feed: "Subscribed calendar"
            }
        }
    }

    let id: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let profileId: String
    let notes: String
    let source: Source
    let calendarId: String?
    let calendarName: String?
    let googleEventId: String?
    let objectUrl: String?
    let writable: Bool
    let seriesId: String?
    let occurrenceDate: String?
    let repeatRule: String?
    let repeatUntil: String?
    let seriesStart: String?
    let seriesEnd: String?
    /// Server-provided `#RRGGBB`; nil when absent or malformed so callers fall back to the profile color.
    let color: String?
    let startDate: Date
    let endDate: Date

    private enum CodingKeys: String, CodingKey {
        case id, title, start, end, allDay, profileId, notes, source, calendarId, calendarName, googleEventId
        case objectUrl, writable, seriesId, occurrenceDate, repeatRule, repeatUntil, seriesStart, seriesEnd, color
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        start = try container.decode(String.self, forKey: .start)
        end = try container.decode(String.self, forKey: .end)
        allDay = try container.decode(Bool.self, forKey: .allDay)
        profileId = try container.decode(String.self, forKey: .profileId)
        notes = try container.decodeIfPresent(String.self, forKey: .notes) ?? ""
        source = try container.decode(Source.self, forKey: .source)
        calendarId = try container.decodeIfPresent(String.self, forKey: .calendarId)
        calendarName = try container.decodeIfPresent(String.self, forKey: .calendarName)
        googleEventId = try container.decodeIfPresent(String.self, forKey: .googleEventId)
        objectUrl = try container.decodeIfPresent(String.self, forKey: .objectUrl)
        writable = try container.decodeIfPresent(Bool.self, forKey: .writable) ?? false
        seriesId = try container.decodeIfPresent(String.self, forKey: .seriesId)
        occurrenceDate = try container.decodeIfPresent(String.self, forKey: .occurrenceDate)
        repeatRule = try container.decodeIfPresent(String.self, forKey: .repeatRule)
        repeatUntil = try container.decodeIfPresent(String.self, forKey: .repeatUntil)
        seriesStart = try container.decodeIfPresent(String.self, forKey: .seriesStart)
        seriesEnd = try container.decodeIfPresent(String.self, forKey: .seriesEnd)
        color = (try? container.decodeIfPresent(String.self, forKey: .color)).flatMap(Self.validColor)
        guard let startDate = allDay ? FamilyDates.day(fromKey: start) : FamilyDates.instant(start),
              let endDate = allDay ? FamilyDates.day(fromKey: end) : FamilyDates.instant(end) else {
            throw DecodingError.dataCorruptedError(forKey: .start, in: container, debugDescription: "Unrecognized event date.")
        }
        self.startDate = startDate
        self.endDate = endDate
    }

    private static func validColor(_ value: String) -> String? {
        let hex = value.dropFirst()
        return value.hasPrefix("#") && hex.count == 6 && hex.allSatisfy { $0.isASCII && $0.isHexDigit } ? value : nil
    }

    var isRecurring: Bool { seriesId != nil }

    /// Where edits are sent; nil for read-only sources (Outlook, feeds, read-only Google/iCloud calendars).
    var location: EventLocation? {
        switch source {
        case .local:
            .local(seriesId: seriesId ?? id, occurrenceDate: occurrenceDate)
        case .google:
            if writable, let calendarId, let googleEventId { .google(calendarId: calendarId, eventId: googleEventId) } else { nil }
        case .icloud:
            if writable, let calendarId, let objectUrl { .icloud(calendarId: calendarId, objectUrl: objectUrl) } else { nil }
        case .outlook, .feed:
            nil
        }
    }

    func occurs(on day: Date) -> Bool {
        startDate < FamilyDates.adding(days: 1, to: day) && endDate > day
    }
}
