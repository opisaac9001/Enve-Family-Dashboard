import Foundation

struct Reward: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let profileId: String
    let title: String
    let cost: Int
}

struct Goal: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let profileId: String
    let title: String
    let target: Int
}

struct RewardBalance: Decodable, Hashable, Sendable {
    let profileId: String
    let stars: Int
}

struct RewardEntry: Decodable, Hashable, Sendable {
    let profileId: String
    let label: String
    let stars: Int
    let createdAt: String
}
