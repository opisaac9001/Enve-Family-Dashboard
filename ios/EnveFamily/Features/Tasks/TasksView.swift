import SwiftUI

struct TasksView: View {
    private enum Filter: String, CaseIterable, Identifiable {
        case all, chore, routine, habit

        var id: Self { self }

        var title: String { self == .all ? "All" : rawValue.capitalized + "s" }
    }

    @Environment(AppModel.self) private var model
    @State private var filter: Filter = .all
    @State private var isCreating = false
    @State private var celebration: TaskCelebration?

    var body: some View {
        let tasks = visibleTasks
        let open = tasks.filter { !$0.completed }
        let done = tasks.filter(\.completed)
        NavigationStack {
            List {
                Section {
                    Picker("Type", selection: $filter) {
                        ForEach(Filter.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    ProfileFilterBar()
                    if filter == .routine, let progress = routineProgress {
                        Text(progress).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .listRowSeparator(.hidden)

                if tasks.isEmpty {
                    ContentUnavailableView("All Caught Up", systemImage: "checkmark.circle", description: Text("Add a task when something comes to mind."))
                }
                if !open.isEmpty {
                    Section("To Do") {
                        ForEach(open) { TaskRow(task: $0, streak: streak(for: $0), onCompleted: celebrate) }
                    }
                }
                if !done.isEmpty {
                    Section("Done") {
                        ForEach(done) { TaskRow(task: $0, streak: streak(for: $0), onCompleted: celebrate) }
                    }
                }
            }
            .refreshable { await model.load() }
            .taskCelebration($celebration)
            .navigationTitle("Tasks")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SettingsButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { isCreating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New Task")
                }
            }
            .sheet(isPresented: $isCreating) {
                NavigationStack {
                    TaskEditorView { isCreating = false }
                }
                .pinPromptHost(level: 1)
            }
        }
    }

    private func celebrate(_ task: FamilyTask) {
        celebration = TaskCelebration(task: task)
    }

    private var visibleTasks: [FamilyTask] {
        (model.state?.tasks ?? [])
            .filter { model.isVisible(profileId: $0.profileId) && (filter == .all || $0.taskType == filter.rawValue) }
            .sorted { ($0.dueDate ?? "9999", $0.dueTime ?? "") < ($1.dueDate ?? "9999", $1.dueTime ?? "") }
    }

    private var routineProgress: String? {
        let today = FamilyDates.dayKey(.now)
        let routines = (model.state?.tasks ?? []).filter { $0.taskType == "routine" && $0.dueDate == today && model.isVisible(profileId: $0.profileId) }
        guard !routines.isEmpty else { return nil }
        return "\(routines.filter { $0.completed && !$0.skipped }.count) of \(routines.count) routines done today"
    }

    /// Mirrors the web UI: consecutive completed (not skipped) habits in a series, ignoring open future ones.
    private func streak(for task: FamilyTask) -> Int {
        guard task.taskType == "habit" else { return 0 }
        let today = FamilyDates.dayKey(.now)
        let series = (model.state?.tasks ?? [])
            .filter { $0.seriesId == task.seriesId }
            .sorted { ($0.dueDate ?? "") > ($1.dueDate ?? "") }
        var streak = 0
        for item in series {
            if !item.completed, let due = item.dueDate, due >= today { continue }
            if !item.completed || item.skipped { break }
            streak += 1
        }
        return streak
    }
}
