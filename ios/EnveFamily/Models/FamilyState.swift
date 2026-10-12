import Foundation

struct FamilyState: Decodable, Sendable {
    let profiles: [Profile]
    let settings: [String: String]
    let tasks: [FamilyTask]
    let rewards: [Reward]
    let goals: [Goal]
    let rewardBalances: [RewardBalance]
    let rewardHistory: [RewardEntry]
    let events: [CalendarEvent]
    let syncFailures: [SyncFailure]
    let accounts: [CalendarAccount]
    let calendars: [ConnectedCalendar]
    let lists: [HouseholdList]
    let listItems: [ListItem]
    let meals: [Meal]
    let recipes: [Recipe]
    private let mealCategories: [MealCategory]?
    private let cloudMealIdeasConfigured: Bool?
    let outlookAccounts: [CalendarAccount]
    let outlookCalendars: [ConnectedCalendar]
    let icloudAccounts: [CalendarAccount]
    let icloudCalendars: [ConnectedCalendar]
    let feedCalendars: [FeedCalendar]

    func profile(_ id: String) -> Profile? {
        profiles.first { $0.id == id }
    }

    func balance(for profileId: String) -> Int {
        rewardBalances.first { $0.profileId == profileId }?.stars ?? 0
    }

    var allMealCategories: [MealCategory] {
        mealCategories ?? MealCategory.defaults
    }

    var enabledMealCategories: [MealCategory] {
        allMealCategories.filter(\.enabled)
    }

    var canUseCloudMealIdeas: Bool {
        cloudMealIdeasConfigured == true
    }

    func mealCategory(_ id: String) -> MealCategory {
        allMealCategories.first { $0.id == id } ?? MealCategory(id: id, name: id, color: "#F5921A", enabled: false)
    }

    func recipe(_ id: String) -> Recipe? {
        recipes.first { $0.id == id }
    }

    /// Household members who can claim family chores, matching the web UI's exclusion list.
    var claimants: [Profile] {
        profiles.filter { !["family", "enve"].contains($0.id) }
    }
}

struct Profile: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let color: String
}

struct SyncFailure: Decodable, Hashable, Sendable {
    let calendar: String
    let message: String
}
