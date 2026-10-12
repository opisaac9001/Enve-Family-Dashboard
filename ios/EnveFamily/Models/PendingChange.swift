import Foundation

/// A create made while the server was unreachable. Only additive, local-data operations are queued.
enum PendingOperation: Codable, Sendable {
    case event(EventPayload)
    case task(TaskPayload)
    case listItem(listId: String, title: String, section: String)
    case meal(MealPayload)

    var title: String {
        switch self {
        case .event(let payload): payload.title
        case .task(let payload): payload.title
        case .listItem(_, let title, _): title
        case .meal(let payload): payload.title
        }
    }

    var kindTitle: String {
        switch self {
        case .event: "Event"
        case .task: "Task"
        case .listItem: "List item"
        case .meal: "Meal"
        }
    }

    var symbol: String {
        switch self {
        case .event: "calendar"
        case .task: "checklist"
        case .listItem: "list.bullet"
        case .meal: "fork.knife"
        }
    }

    func send(with client: APIClient) async throws {
        switch self {
        case .event(let payload): try await client.createEvent(payload, in: .local)
        case .task(let payload): try await client.createTask(payload)
        case .listItem(let listId, let title, let section): try await client.addListItem(to: listId, title: title, section: section)
        case .meal(let payload): try await client.createMeal(payload)
        }
    }
}

struct PendingChange: Codable, Identifiable, Sendable {
    enum Status: Codable, Equatable, Sendable {
        case waiting
        case sending
        /// Needs a person to retry or discard, because the server may already have it.
        case failed(String)
    }

    let id: UUID
    let server: String
    let createdAt: Date
    let operation: PendingOperation
    var status: Status
}
