import Foundation

struct SearchHit: Identifiable, Hashable, Sendable {
    let id: String
    let itemId: String?
    let kind: String
    let title: String
    let date: Date?
    let allDay: Bool
    let detail: String?

    var isEvent: Bool { kind == "event" }

    /// Accepts a flat array, `{ results: [...] }`, or arrays grouped by kind such as `{ events: [...], tasks: [...] }`.
    static func hits(in json: JSONValue) -> [SearchHit] {
        let groups: [(kind: String?, items: [JSONValue])]
        if let items = json.array ?? json["results"]?.array {
            groups = [(nil, items)]
        } else {
            groups = (json.object ?? [:])
                .sorted { $0.key < $1.key }
                .compactMap { key, value -> (kind: String?, items: [JSONValue])? in
                    guard let items = value.array else { return nil }
                    return (kind: Optional(singular(key)), items: items)
                }
        }
        var seen = Set<String>()
        return groups.flatMap { group in
            group.items.enumerated().compactMap { index, item in
                SearchHit(item, kind: group.kind, fallbackId: "\(group.kind ?? "result")-\(index)")
            }
        }
        .filter { seen.insert($0.id).inserted }
    }

    private init?(_ item: JSONValue, kind groupKind: String?, fallbackId: String) {
        guard let title = item.first("title", "name", "text")?.string, !title.isEmpty else { return nil }
        let start = item.first("start", "date", "day", "dueDate", "due_date")?.string
        let declaredKind = item.first("type", "kind")?.string.map(Self.singular)
        kind = declaredKind ?? groupKind ?? (item["start"] != nil ? "event" : "result")
        itemId = item["id"]?.string
        id = "\(kind):\(itemId ?? fallbackId)"
        self.title = title
        date = start.flatMap(FamilyDates.eventDate)
        allDay = item["allDay"]?.bool ?? start.map(FamilyDates.isDayKey) ?? true
        detail = item.first("calendarName", "listName", "category", "notes")?.string.flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func singular(_ key: String) -> String {
        let lower = key.lowercased()
        return switch lower {
        case "listitems", "list_items": "listItem"
        case "connectedevents": "event"
        default: lower.hasSuffix("s") ? String(lower.dropLast()) : lower
        }
    }
}
