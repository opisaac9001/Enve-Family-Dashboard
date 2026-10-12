import Foundation

enum ListSortOrder: String, CaseIterable, Identifiable, Sendable {
    case added, alpha, checked

    var id: Self { self }

    var title: String {
        switch self {
        case .added: "Date Added"
        case .alpha: "A to Z"
        case .checked: "Unchecked First"
        }
    }
}

struct HouseholdList: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let sortOrder: String

    private enum CodingKeys: String, CodingKey {
        case id, name
        case sortOrder = "sort_order"
    }

    static let groceriesId = "groceries"
}

struct ListItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let listId: String
    let title: String
    let checked: Bool
    let section: String
}

struct MealCategory: Codable, Identifiable, Hashable, Sendable {
    /// Cached state saved before the server had renameable categories.
    static let defaults = ["Breakfast", "Lunch", "Dinner", "Snack"].map {
        MealCategory(id: $0, name: $0, color: "#F5921A", enabled: true)
    }

    let id: String
    var name: String
    var color: String
    var enabled: Bool
}

enum MealRepeatRule: String, CaseIterable, Identifiable, Sendable {
    case none, daily, weekly, monthly

    var id: Self { self }

    var title: String {
        self == .none ? "Never" : rawValue.capitalized
    }
}

struct Meal: Decodable, Identifiable, Hashable, Sendable {
    static let maxRecipes = 6

    let id: String
    let day: String
    let category: String
    let title: String
    let notes: String
    let recipeIds: [String]
    let servings: Int?
    let seriesId: String?
    let repeatRule: MealRepeatRule
    let repeatUntil: String?

    var isRepeating: Bool { repeatRule != .none }

    var repeatSummary: String? {
        guard isRepeating else { return nil }
        guard let until = repeatUntil.flatMap(FamilyDates.day(fromKey:)) else { return "Repeats \(repeatRule.rawValue)" }
        return "Repeats \(repeatRule.rawValue) until \(until.formatted(.dateTime.month(.abbreviated).day()))"
    }

    private enum CodingKeys: String, CodingKey {
        case id, day, category, title, notes, servings, recipeIds, seriesId, repeatRule, repeatUntil
        case recipeId = "recipe_id"
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        day = try container.decode(String.self, forKey: .day)
        category = try container.decode(String.self, forKey: .category)
        title = try container.decode(String.self, forKey: .title)
        notes = try container.decode(String.self, forKey: .notes)
        servings = try container.decodeIfPresent(Int.self, forKey: .servings)
        // Cached state from older servers only has the single `recipe_id`.
        recipeIds = try container.decodeIfPresent([String].self, forKey: .recipeIds)
            ?? [try container.decodeIfPresent(String.self, forKey: .recipeId)].compactMap { $0 }
        seriesId = try container.decodeIfPresent(String.self, forKey: .seriesId)
        repeatRule = try container.decodeIfPresent(String.self, forKey: .repeatRule).flatMap(MealRepeatRule.init) ?? .none
        repeatUntil = try container.decodeIfPresent(String.self, forKey: .repeatUntil)
    }
}

/// A recipe written by the built-in or cloud idea generator, saved to the recipe box only when its meal is planned.
struct DraftRecipe: Codable, Hashable, Sendable {
    var title: String
    var ingredients: String
    var directions: String
    var servings: Int

    private enum CodingKeys: String, CodingKey {
        case title, ingredients, directions, servings
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        // Recipes store ingredients as newline-separated text; accept a line array too.
        if let lines = try? container.decode([String].self, forKey: .ingredients) {
            ingredients = lines.joined(separator: "\n")
        } else {
            ingredients = try container.decode(String.self, forKey: .ingredients)
        }
        directions = try container.decodeIfPresent(String.self, forKey: .directions) ?? ""
        servings = try container.decode(Int.self, forKey: .servings)
    }
}

struct MealSuggestion: Decodable, Hashable, Sendable {
    let day: String
    let category: String
    let recipeId: String?
    let title: String
    let servings: Int
    let ingredients: [String]
    let draftRecipe: DraftRecipe?
}

struct Recipe: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let ingredients: String
    let directions: String
    let servings: Int
    let photoId: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, ingredients, directions, servings
        case photoId = "photo_id"
    }
}
