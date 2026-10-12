import SwiftUI

struct TaskRow: View {
    @Environment(AppModel.self) private var model
    let task: FamilyTask
    let streak: Int
    let onCompleted: (FamilyTask) -> Void

    var body: some View {
        let profile = model.state?.profile(task.profileId)
        let color = Color(hex: profile?.color ?? "#F5921A")
        HStack(spacing: 12) {
            if task.canClaim {
                Menu {
                    ForEach(model.state?.claimants ?? []) { claimant in
                        Button(claimant.name) {
                            let id = task.id
                            Task { await model.run { try await $0.claimTask(id, for: claimant.id) } }
                        }
                    }
                } label: {
                    Image(systemName: "star.circle").font(.title2).foregroundStyle(color)
                }
                .accessibilityLabel("Claim \(task.title)")
            } else {
                Button {
                    let task = task
                    let id = task.id
                    let completed = !task.completed
                    Task {
                        if await model.run({ try await $0.setTask(id, completed: completed) }), completed {
                            onCompleted(task)
                        }
                    }
                } label: {
                    Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                        .font(.title2)
                        .foregroundStyle(color)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(task.completed ? "Mark \(task.title) not done" : "Complete \(task.title)")
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .strikethrough(task.completed)
                    .foregroundStyle(task.completed ? .secondary : .primary)
                Text(details(profile: profile))
                    .font(.footnote)
                    .foregroundStyle(isOverdue ? Color.red : Color.secondary)
                if let rotation {
                    Label(rotation, systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) {
                let id = task.id
                Task { await model.run { try await $0.deleteTask(id) } }
            }
        }
        .swipeActions(edge: .leading) {
            if !task.completed && !task.canClaim && task.dueDate != nil {
                Button("Skip") {
                    let id = task.id
                    Task { await model.run { try await $0.skipTask(id) } }
                }
                .tint(.gray)
            }
        }
    }

    private var isOverdue: Bool {
        guard !task.completed, let dueDate = task.dueDate else { return false }
        return dueDate < FamilyDates.dayKey(.now)
    }

    private var rotation: String? {
        guard let next = task.nextRotationProfileId else { return nil }
        let name = { (id: String) in model.state?.profile(id)?.name ?? "Unknown" }
        let order = task.rotationProfiles.map(name).joined(separator: " → ")
        return task.completed ? "Takes turns: \(order)" : "Takes turns: \(order) · Next: \(name(next))"
    }

    private func details(profile: Profile?) -> String {
        var parts = [profile?.name ?? "", task.taskType.capitalized]
        if let dueDate = task.dueDate, let day = FamilyDates.day(fromKey: dueDate) {
            var due = day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
            if let dueTime = task.dueTime, let time = FamilyDates.time(fromKey: dueTime, on: day) {
                due += " " + time.formatted(date: .omitted, time: .shortened)
            }
            parts.append(due)
        }
        if task.repeatRule != "none" { parts.append(task.repeatRule.capitalized) }
        if task.starValue > 0 { parts.append("★ \(task.starValue)") }
        if streak > 0 { parts.append("\(streak) streak") }
        if task.skipped { parts.append("Skipped") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
