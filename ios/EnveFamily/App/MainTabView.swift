import SwiftUI

struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView {
            CalendarView()
                .tabItem { Label("Calendar", systemImage: "calendar") }
            TasksView()
                .tabItem { Label("Tasks", systemImage: "checklist") }
            ListsView()
                .tabItem { Label("Lists", systemImage: "list.bullet.rectangle") }
            MealsView()
                .tabItem { Label("Meals", systemImage: "fork.knife") }
            RewardsView()
                .tabItem { Label("Rewards", systemImage: "star") }
        }
        .onChange(of: model.rangeKey) {
            Task { await model.load() }
        }
        .sheet(isPresented: $model.isShowingSettings) {
            SettingsView()
                .pinPromptHost(level: 1)
        }
        .sheet(isPresented: $model.isShowingPendingChanges) {
            PendingChangesView()
                .pinPromptHost(level: 1)
        }
        .sheet(isPresented: $model.isShowingImport) {
            ImportView()
                .pinPromptHost(level: 1)
        }
        .alert("Enve Family", isPresented: Binding(get: { model.banner != nil }, set: { if !$0 { model.banner = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.banner ?? "")
        }
        .pinPromptHost(level: 0)
    }
}

struct SettingsButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack {
            Button {
                model.isShowingSettings = true
            } label: {
                Image(systemName: "gearshape")
            }
            .accessibilityLabel("Settings")
            SyncStatusButton()
        }
    }
}

/// Shown only while offline or with creates waiting to send.
private struct SyncStatusButton: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model

    var body: some View {
        let count = model.pendingChanges.count
        if model.isOffline || count > 0 {
            Button {
                model.isShowingPendingChanges = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: model.isOffline ? "wifi.slash" : "arrow.triangle.2.circlepath")
                    if count > 0 { Text("\(count)").font(.subheadline.monospacedDigit()) }
                }
                .foregroundStyle(accent)
            }
            .accessibilityLabel(model.isOffline ? "Offline" : "Sync status")
            .accessibilityValue(count > 0 ? "\(count) waiting to send" : "")
        }
    }
}
