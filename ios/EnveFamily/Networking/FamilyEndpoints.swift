import Foundation

enum EventScope: Hashable, Sendable {
    case series
    case occurrence
}

enum EventCalendar: Hashable, Sendable {
    case local
    case google(calendarId: String)
    case icloud(calendarId: String)
}

enum EventLocation: Sendable {
    case local(seriesId: String, occurrenceDate: String?)
    case google(calendarId: String, eventId: String)
    case icloud(calendarId: String, objectUrl: String)
}

struct EventPayload: Codable, Sendable {
    var title: String
    var profileId: String
    var allDay: Bool
    var start: String
    var end: String
    var notes: String
    var localStart: String
    var localEnd: String
    var timeZone: String
    var repeatRule: String
    var repeatUntil: String?
    var calendarId: String?
    var objectUrl: String?
}

struct TaskPayload: Codable, Sendable {
    let title: String
    let profileId: String
    let dueDate: String?
    let dueTime: String?
    let repeatRule: String
    let starValue: Int
    let taskType: String
    let claimable: Bool
    let rotationProfiles: [String]?
}

/// Queued offline as part of `PendingOperation`, so new fields stay optional for payloads saved by earlier builds.
struct MealPayload: Codable, Sendable {
    let day: String
    let category: String
    let title: String
    let notes: String
    let recipeId: String?
    let servings: Int?
    let recipeIds: [String]?
    let repeatRule: String?
    let repeatUntil: String?
}

enum MealScope: String, Identifiable, Sendable {
    case occurrence, series

    var id: Self { self }
}

/// Only changed fields are sent. `repeatUntil: .some(nil)` encodes `null` to remove an end date.
struct MealUpdate: Encodable, Sendable {
    var day: String?
    var category: String?
    var title: String?
    var notes: String?
    var recipeIds: [String]?
    var servings: Int?
    var repeatRule: String?
    var repeatUntil: String??

    var isEmpty: Bool {
        day == nil && category == nil && title == nil && notes == nil && recipeIds == nil
            && servings == nil && repeatRule == nil && repeatUntil == nil
    }
}

enum MealIdeaSource: String, Encodable, Sendable {
    case builtin, cloud
}

struct MealSuggestionRequest: Encodable, Sendable {
    let startDay: String
    let categories: [String]
    let servings: Int
    let avoid: String
    /// Set only for `/api/meals/ideas`.
    let source: MealIdeaSource?
}

struct PlannedMealPayload: Encodable, Sendable {
    let day: String
    let category: String
    let servings: Int
    let notes: String
    let recipeId: String?
    let draftRecipe: DraftRecipe?
}

struct PlanResult: Decodable, Sendable {
    let ids: [String]
    let createdRecipeIds: [String]
}

struct GroceryResult: Decodable, Sendable {
    let added: Int
    let updated: Int
    let ingredients: [String]
    let skippedMealIds: [String]
}

struct RecipePayload: Encodable, Sendable {
    let title: String
    let ingredients: String
    let directions: String
    let servings: Int
    let photoId: String?
}

private struct ImportPayload: Encodable, Sendable {
    let type: ImportKind
    let text: String?
    let data: String?
}

private struct ListItemPayload: Encodable, Sendable {
    let listId: String
    let title: String
    let section: String
}

private struct RewardPayload: Encodable, Sendable {
    let title: String
    let profileId: String
    let cost: Int
}

private struct GoalPayload: Encodable, Sendable {
    let title: String
    let profileId: String
    let target: Int
}

extension APIClient {
    func login(username: String?, password: String) async throws {
        try await send(.post, "/api/login", body: ["username": username ?? "", "key": password])
    }

    func unlockPin(_ pin: String) async throws {
        try await send(.post, "/api/pin/unlock", body: ["pin": pin])
    }

    /// Raw `/api/state` JSON, so the last good response can be cached for offline reading.
    func stateData(from: String, to: String) async throws -> Data {
        try await data("/api/state", query: [URLQueryItem(name: "from", value: from), URLQueryItem(name: "to", value: to)])
    }

    func search(_ query: String) async throws -> JSONValue {
        try await request(.get, "/api/search", query: [URLQueryItem(name: "q", value: query)])
    }

    func weather() async throws -> JSONValue {
        try await request(.get, "/api/weather")
    }

    // MARK: Household settings

    func updateSettings(_ values: [String: String]) async throws {
        try await send(.patch, "/api/settings", body: values)
    }

    func updateProfile(_ id: String, name: String, color: String) async throws {
        try await send(.patch, "/api/profiles/\(Self.pathComponent(id))", body: ["name": name, "color": color])
    }

    func photos() async throws -> JSONValue {
        try await request(.get, "/api/photos")
    }

    func backup() async throws -> Data {
        try await data("/api/backup", timeout: 120)
    }

    func restore(_ backup: Data) async throws {
        try await send(.post, "/api/restore", json: backup, timeout: 120)
    }

    // MARK: Import

    /// Server OCR can run for up to two minutes before it responds.
    func importDrafts(_ kind: ImportKind, source: ImportSource) async throws -> ImportResult {
        let payload = switch source {
        case .text(let text): ImportPayload(type: kind, text: text, data: nil)
        case .file(let data): ImportPayload(type: kind, text: nil, data: data.base64EncodedString())
        }
        return try await request(.post, "/api/import/drafts", body: payload, timeout: 150)
    }

    // MARK: Events

    func createEvent(_ payload: EventPayload, in calendar: EventCalendar) async throws {
        var body = payload
        switch calendar {
        case .local:
            try await send(.post, "/api/events", body: body)
        case .google(let calendarId):
            body.calendarId = calendarId
            try await send(.post, "/api/google/events", body: body)
        case .icloud(let calendarId):
            body.calendarId = calendarId
            try await send(.post, "/api/icloud/events", body: body)
        }
    }

    func updateEvent(at location: EventLocation, payload: EventPayload, scope: EventScope) async throws {
        var body = payload
        switch location {
        case .local(let seriesId, let occurrenceDate):
            try await send(.patch, "/api/events/\(Self.pathComponent(seriesId))", query: Self.occurrenceQuery(occurrenceDate, scope), body: body)
        case .google(let calendarId, let eventId):
            try await send(.patch, "/api/google/events/\(Self.pathComponent(calendarId))/\(Self.pathComponent(eventId))", body: body)
        case .icloud(let calendarId, let objectUrl):
            body.calendarId = calendarId
            body.objectUrl = objectUrl
            try await send(.patch, "/api/icloud/events", body: body)
        }
    }

    func deleteEvent(at location: EventLocation, scope: EventScope) async throws {
        switch location {
        case .local(let seriesId, let occurrenceDate):
            try await send(.delete, "/api/events/\(Self.pathComponent(seriesId))", query: Self.occurrenceQuery(occurrenceDate, scope))
        case .google(let calendarId, let eventId):
            try await send(.delete, "/api/google/events/\(Self.pathComponent(calendarId))/\(Self.pathComponent(eventId))")
        case .icloud(let calendarId, let objectUrl):
            try await send(.delete, "/api/icloud/events", body: ["calendarId": calendarId, "objectUrl": objectUrl])
        }
    }

    private static func occurrenceQuery(_ occurrenceDate: String?, _ scope: EventScope) -> [URLQueryItem] {
        guard scope == .occurrence, let occurrenceDate else { return [] }
        return [URLQueryItem(name: "occurrence", value: occurrenceDate)]
    }

    // MARK: Tasks

    func createTask(_ payload: TaskPayload) async throws {
        try await send(.post, "/api/tasks", body: payload)
    }

    func setTask(_ id: String, completed: Bool) async throws {
        try await send(.patch, "/api/tasks/\(Self.pathComponent(id))", body: ["completed": completed])
    }

    func skipTask(_ id: String) async throws {
        try await send(.patch, "/api/tasks/\(Self.pathComponent(id))", body: ["skipped": true])
    }

    func claimTask(_ id: String, for profileId: String) async throws {
        try await send(.patch, "/api/tasks/\(Self.pathComponent(id))", body: ["claimProfileId": profileId])
    }

    func deleteTask(_ id: String) async throws {
        try await send(.delete, "/api/tasks/\(Self.pathComponent(id))")
    }

    // MARK: Lists

    func createList(named name: String) async throws {
        try await send(.post, "/api/lists", body: ["name": name])
    }

    func setListSort(_ id: String, to sortOrder: ListSortOrder) async throws {
        try await send(.patch, "/api/lists/\(Self.pathComponent(id))", body: ["sortOrder": sortOrder.rawValue])
    }

    func deleteList(_ id: String) async throws {
        try await send(.delete, "/api/lists/\(Self.pathComponent(id))")
    }

    func addListItem(to listId: String, title: String, section: String) async throws {
        try await send(.post, "/api/list-items", body: ListItemPayload(listId: listId, title: title, section: section))
    }

    func setListItem(_ id: String, checked: Bool) async throws {
        try await send(.patch, "/api/list-items/\(Self.pathComponent(id))", body: ["checked": checked])
    }

    func deleteListItem(_ id: String) async throws {
        try await send(.delete, "/api/list-items/\(Self.pathComponent(id))")
    }

    // MARK: Meals and recipes

    func createMeal(_ payload: MealPayload) async throws {
        try await send(.post, "/api/meals", body: payload)
    }

    func updateMeal(_ id: String, _ update: MealUpdate, scope: MealScope?) async throws {
        try await send(.patch, "/api/meals/\(Self.pathComponent(id))", query: Self.mealScopeQuery(scope), body: update)
    }

    func deleteMeal(_ id: String, scope: MealScope?) async throws {
        try await send(.delete, "/api/meals/\(Self.pathComponent(id))", query: Self.mealScopeQuery(scope))
    }

    private static func mealScopeQuery(_ scope: MealScope?) -> [URLQueryItem] {
        scope.map { [URLQueryItem(name: "scope", value: $0.rawValue)] } ?? []
    }

    func updateMealCategories(_ categories: [MealCategory]) async throws {
        try await send(.patch, "/api/meal-categories", body: categories)
    }

    func suggestMeals(_ request: MealSuggestionRequest) async throws -> [MealSuggestion] {
        struct Suggestions: Decodable, Sendable { let suggestions: [MealSuggestion] }
        let path = request.source == nil ? "/api/meals/suggestions" : "/api/meals/ideas"
        // Cloud ideas wait on OpenAI through the server.
        let result: Suggestions = try await self.request(.post, path, body: request, timeout: request.source == .cloud ? 120 : nil)
        return result.suggestions
    }

    func planMeals(_ meals: [PlannedMealPayload]) async throws -> PlanResult {
        try await request(.post, "/api/meals/plan", body: ["meals": meals])
    }

    func addMealsToGroceries(_ mealIds: [String]) async throws -> GroceryResult {
        try await request(.post, "/api/meals/groceries", body: ["mealIds": mealIds])
    }

    func saveRecipe(_ payload: RecipePayload, id: String?) async throws {
        if let id {
            try await send(.patch, "/api/recipes/\(Self.pathComponent(id))", body: payload)
        } else {
            try await send(.post, "/api/recipes", body: payload)
        }
    }

    func deleteRecipe(_ id: String) async throws {
        try await send(.delete, "/api/recipes/\(Self.pathComponent(id))")
    }

    func scaledIngredients(for id: String, servings: Int) async throws -> String {
        struct Scaled: Decodable, Sendable { let ingredients: String }
        let scaled: Scaled = try await request(.get, "/api/recipes/\(Self.pathComponent(id))/scale",
                                               query: [URLQueryItem(name: "servings", value: String(servings))])
        return scaled.ingredients
    }

    func addRecipeToGroceries(_ id: String, servings: Int) async throws -> Int {
        struct Added: Decodable, Sendable { let added: Int }
        let result: Added = try await request(.post, "/api/recipes/\(Self.pathComponent(id))/groceries", body: ["servings": servings])
        return result.added
    }

    func photo(id: String) async throws -> Data {
        try await data("/api/photos/\(Self.pathComponent(id))")
    }

    // MARK: Rewards

    func createReward(title: String, profileId: String, cost: Int) async throws {
        try await send(.post, "/api/rewards", body: RewardPayload(title: title, profileId: profileId, cost: cost))
    }

    func redeemReward(_ id: String) async throws {
        try await send(.post, "/api/rewards/\(Self.pathComponent(id))/redeem")
    }

    func deleteReward(_ id: String) async throws {
        try await send(.delete, "/api/rewards/\(Self.pathComponent(id))")
    }

    func createGoal(title: String, profileId: String, target: Int) async throws {
        try await send(.post, "/api/goals", body: GoalPayload(title: title, profileId: profileId, target: target))
    }

    func deleteGoal(_ id: String) async throws {
        try await send(.delete, "/api/goals/\(Self.pathComponent(id))")
    }
}
