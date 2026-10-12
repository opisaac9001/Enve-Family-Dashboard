import SwiftUI

@main
struct EnveFamilyApp: App {
    @State private var model = AppModel()
    @State private var theme = ThemeManager()

    var body: some Scene {
        WindowGroup {
            TimelineView(.periodic(from: .now, by: 60)) { timeline in
                let accent = Color(hex: model.state?.settings["accent_color"] ?? "#F5921A")
                RootView()
                    .environment(model)
                    .environment(theme)
                    .environment(\.enveAccent, accent)
                    .tint(accent)
                    .preferredColorScheme(theme.colorScheme(settings: model.state?.settings, at: timeline.date))
            }
        }
    }
}
