import SwiftUI

struct RewardsView: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model
    @State private var creating: RewardEditorView.Kind?
    @State private var rewardToRedeem: Reward?
    @State private var rewardToDelete: Reward?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.state?.profiles ?? []) { profile in
                    profileSection(profile)
                }

                if let history = model.state?.rewardHistory, !history.isEmpty {
                    Section("Recent Activity") {
                        ForEach(Array(history.enumerated()), id: \.offset) { _, entry in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.label)
                                    Text([model.state?.profile(entry.profileId)?.name, FamilyDates.instant(entry.createdAt)?.formatted(.relative(presentation: .named))]
                                        .compactMap { $0 }.joined(separator: " · "))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(entry.stars > 0 ? "+\(entry.stars) ★" : "\(entry.stars) ★")
                                    .monospacedDigit()
                                    .foregroundStyle(entry.stars > 0 ? accent : Color.secondary)
                            }
                        }
                    }
                }
            }
            .refreshable { await model.load() }
            .navigationTitle("Rewards")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SettingsButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New Reward") { creating = .reward }
                        Button("New Goal") { creating = .goal }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add")
                }
            }
            .sheet(item: $creating) { kind in
                NavigationStack {
                    RewardEditorView(kind: kind) { creating = nil }
                }
                .pinPromptHost(level: 1)
            }
            .confirmationDialog("Redeem Reward?", isPresented: Binding(get: { rewardToRedeem != nil }, set: { if !$0 { rewardToRedeem = nil } }),
                                titleVisibility: .visible, presenting: rewardToRedeem) { reward in
                Button("Redeem for \(reward.cost) ★") {
                    let id = reward.id
                    Task { await model.run { try await $0.redeemReward(id) } }
                }
            } message: { reward in
                Text("\(model.state?.profile(reward.profileId)?.name ?? "This person") will spend \(reward.cost) stars on \(reward.title).")
            }
            .confirmationDialog("Delete Reward?", isPresented: Binding(get: { rewardToDelete != nil }, set: { if !$0 { rewardToDelete = nil } }),
                                titleVisibility: .visible, presenting: rewardToDelete) { reward in
                Button("Delete \(reward.title)", role: .destructive) {
                    let id = reward.id
                    Task { await model.run { try await $0.deleteReward(id) } }
                }
            } message: { _ in
                Text("Past redemptions stay in the history.")
            }
        }
    }

    private func profileSection(_ profile: Profile) -> some View {
        let balance = model.state?.balance(for: profile.id) ?? 0
        let goals = model.state?.goals.filter { $0.profileId == profile.id } ?? []
        let rewards = model.state?.rewards.filter { $0.profileId == profile.id } ?? []
        return Section {
            ForEach(goals) { goal in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(goal.title)
                        Spacer()
                        Text("\(min(max(balance, 0), goal.target)) of \(goal.target) ★")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    ProgressView(value: Double(min(max(balance, 0), goal.target)), total: Double(goal.target))
                        .tint(Color(hex: profile.color))
                }
                .swipeActions {
                    Button("Delete", role: .destructive) {
                        let id = goal.id
                        Task { await model.run { try await $0.deleteGoal(id) } }
                    }
                }
            }
            ForEach(rewards) { reward in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reward.title)
                        Text("\(reward.cost) ★").font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Redeem") { rewardToRedeem = reward }
                        .buttonStyle(.bordered)
                        .disabled(balance < reward.cost)
                }
                .swipeActions {
                    Button("Delete", role: .destructive) { rewardToDelete = reward }
                }
            }
            if goals.isEmpty && rewards.isEmpty {
                Text("No rewards yet.").foregroundStyle(.secondary)
            }
        } header: {
            HStack {
                ProfileLabel(profile: profile)
                Spacer()
                Text("★ \(balance)").monospacedDigit().foregroundStyle(accent)
            }
            .font(.headline)
            .textCase(nil)
        }
    }
}
