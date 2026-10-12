import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.phase {
            case .setup:
                ServerSetupView()
            case .needsLogin:
                LoginView()
            case .failed(let message):
                ConnectionErrorView(message: message)
            case .connecting:
                ProgressView("Connecting to \(model.serverAddress)…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready:
                MainTabView()
            }
        }
        .task {
            model.refreshPendingShares()
            await model.start()
        }
        .task(id: scenePhase == .active && model.phase == .ready) {
            if scenePhase == .active, model.phase == .ready { await model.watchChanges() }
        }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            model.refreshPendingShares()
            if model.phase == .ready {
                Task { await model.load() }
            }
        }
        .onChange(of: model.phase) {
            if model.phase == .ready { model.refreshPendingShares() }
        }
    }
}
