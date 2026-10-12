import Foundation

struct FamilyTask: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let dueDate: String?
    let dueTime: String?
    let profileId: String
    let completed: Bool
    let skipped: Bool
    let claimable: Bool
    let claimedBy: String?
    let repeatRule: String
    let taskType: String
    let starValue: Int
    let seriesId: String
    let rotationProfiles: [String]
    let rotationIndex: Int

    var canClaim: Bool { claimable && claimedBy == nil && !completed }
    var rotates: Bool { rotationProfiles.count > 1 }

    var nextRotationProfileId: String? {
        rotates ? rotationProfiles[(rotationIndex + 1) % rotationProfiles.count] : nil
    }
}
