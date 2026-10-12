import SwiftUI

enum Appearance: String, CaseIterable, Identifiable {
    case schedule, system, light, dark

    var id: Self { self }

    var title: String { rawValue.capitalized }

}

@MainActor
@Observable
final class ThemeManager {
    private static let key = "appearance"

    var appearance: Appearance {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: Self.key) }
    }

    init() {
        appearance = UserDefaults.standard.string(forKey: Self.key).flatMap(Appearance.init(rawValue:)) ?? .schedule
    }

    func colorScheme(settings: [String: String]?, at date: Date) -> ColorScheme? {
        switch appearance {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        case .schedule:
            let light = Self.minutes(settings?["light_at"]) ?? 7 * 60
            let dark = Self.minutes(settings?["dark_at"]) ?? 19 * 60
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            let current = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            let isLight = light <= dark ? current >= light && current < dark : current >= light || current < dark
            return isLight ? .light : .dark
        }
    }

    private static func minutes(_ value: String?) -> Int? {
        guard let value else { return nil }
        let parts = value.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return nil }
        return parts[0] * 60 + parts[1]
    }
}
