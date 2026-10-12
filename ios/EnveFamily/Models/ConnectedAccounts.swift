import Foundation

struct CalendarAccount: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let profileId: String
    let email: String
}

struct ConnectedCalendar: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let accountId: String
    let name: String
    let enabled: Bool
    let writable: Bool?
}

struct FeedCalendar: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let profileId: String
    let name: String
    let enabled: Bool
}
