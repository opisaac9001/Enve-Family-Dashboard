import Foundation

enum ImportKind: String, CaseIterable, Identifiable, Encodable, Sendable {
    case event, task, list, recipe

    var id: Self { self }

    var title: String { rawValue.capitalized }
}

enum ImportSource: Sendable {
    case text(String)
    case file(Data)

    static let maxFileSize = ShareInbox.maxPayloadSize
}

struct ImportResult: Decodable, Sendable {
    let text: String
    let drafts: [ImportDraft]
    let message: String?
}

struct EventDraft: Sendable {
    let title: String
    let start: Date
    /// Exclusive, like server events: the day after the last day for all-day drafts.
    let end: Date
    let allDay: Bool
    let notes: String
    let repeatRule: String
}

struct TaskDraft: Sendable {
    let title: String
    let dueDate: Date?
    let dueTime: String?
    let taskType: String
}

struct RecipeDraft: Sendable {
    let title: String
    let ingredients: String
    let directions: String
}

struct ImportDraft: Decodable, Identifiable, Sendable {
    enum Content: Sendable {
        case event(EventDraft)
        case task(TaskDraft)
        case listItem(String)
        case recipe(RecipeDraft)
    }

    let id = UUID()
    let content: Content

    private enum CodingKeys: String, CodingKey {
        case type, title, start, end, allDay, notes, repeatRule, dueDate, dueTime, taskType, ingredients, directions
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let title = try container.decode(String.self, forKey: .title)
        switch try container.decode(String.self, forKey: .type) {
        case "event":
            guard let start = FamilyDates.eventDate(try container.decode(String.self, forKey: .start)),
                  let end = FamilyDates.eventDate(try container.decode(String.self, forKey: .end)) else {
                throw DecodingError.dataCorruptedError(forKey: .start, in: container, debugDescription: "Unrecognized draft date.")
            }
            content = .event(EventDraft(
                title: title,
                start: start,
                end: end,
                allDay: try container.decode(Bool.self, forKey: .allDay),
                notes: try container.decodeIfPresent(String.self, forKey: .notes) ?? "",
                repeatRule: try container.decodeIfPresent(String.self, forKey: .repeatRule) ?? "none"
            ))
        case "task":
            let dueTime = try container.decodeIfPresent(String.self, forKey: .dueTime) ?? ""
            content = .task(TaskDraft(
                title: title,
                dueDate: try container.decodeIfPresent(String.self, forKey: .dueDate).flatMap(FamilyDates.day(fromKey:)),
                dueTime: dueTime.isEmpty ? nil : dueTime,
                taskType: try container.decodeIfPresent(String.self, forKey: .taskType) ?? "chore"
            ))
        case "list":
            content = .listItem(title)
        case "recipe":
            content = .recipe(RecipeDraft(
                title: title,
                ingredients: try container.decodeIfPresent(String.self, forKey: .ingredients) ?? "",
                directions: try container.decodeIfPresent(String.self, forKey: .directions) ?? ""
            ))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown draft type.")
        }
    }
}
