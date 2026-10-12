import SwiftUI

struct TaskCelebration: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let stars: Int

    init(task: FamilyTask) {
        title = task.title
        stars = task.starValue
    }

    var announcement: String {
        stars > 0 ? "\(title) done. \(stars) star\(stars == 1 ? "" : "s") earned." : "\(title) done."
    }
}

/// A brief, non-interactive confirmation shown over the task list after a completion succeeds.
struct TaskCelebrationBanner: View {
    @Environment(\.enveAccent) private var accent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let celebration: TaskCelebration
    @State private var bounce = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .font(.title3)
                .foregroundStyle(accent)
                .symbolEffect(.bounce, value: bounce)
            Text("Nice work!")
                .font(.subheadline.weight(.semibold))
            Text(celebration.title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if celebration.stars > 0 {
                Text("+\(celebration.stars) ★")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(accent)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(accent.opacity(0.35)))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 4)
        .padding(.horizontal)
        .accessibilityHidden(true)
        .onAppear { if !reduceMotion { bounce = true } }
    }
}

extension View {
    /// Shows `TaskCelebrationBanner` for a couple of seconds with a success haptic and a VoiceOver announcement.
    func taskCelebration(_ celebration: Binding<TaskCelebration?>) -> some View {
        modifier(TaskCelebrationModifier(celebration: celebration))
    }
}

private struct TaskCelebrationModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var celebration: TaskCelebration?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let celebration {
                    TaskCelebrationBanner(celebration: celebration)
                        .padding(.bottom, 12)
                        .transition(reduceMotion ? AnyTransition.opacity : .move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.9)))
                        .allowsHitTesting(false)
                }
            }
            .animation(reduceMotion ? Animation.easeInOut(duration: 0.2) : .spring(duration: 0.45, bounce: 0.3), value: celebration)
            .sensoryFeedback(.success, trigger: celebration) { _, new in new != nil }
            .task(id: celebration?.id) {
                guard let current = celebration else { return }
                AccessibilityNotification.Announcement(current.announcement).post()
                try? await Task.sleep(for: .seconds(2.2))
                if celebration?.id == current.id { celebration = nil }
            }
    }
}
