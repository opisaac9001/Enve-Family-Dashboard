import SwiftUI

struct TaskEditorView: View {
    private static let types = ["chore", "routine", "habit"]
    private static let repeatRules = ["none", "daily", "weekly", "monthly"]

    @Environment(AppModel.self) private var model
    let onSave: () -> Void
    let onComplete: () -> Void

    @State private var title: String
    @State private var profileId = "family"
    @State private var taskType: String
    @State private var hasDueDate: Bool
    @State private var dueDate: Date
    @State private var hasDueTime: Bool
    @State private var dueTime: Date
    @State private var repeatRule = "none"
    @State private var starValue = 1
    @State private var claimable = false
    @State private var rotationOthers: Set<String> = []
    @State private var errorMessage: String?
    @State private var isSaving = false

    init(draft: TaskDraft? = nil, onSave: @escaping () -> Void = {}, onComplete: @escaping () -> Void) {
        self.onSave = onSave
        self.onComplete = onComplete
        let day = draft?.dueDate ?? .now
        let draftTime = draft?.dueTime.flatMap { FamilyDates.time(fromKey: $0, on: day) }
        _title = State(initialValue: draft?.title ?? "")
        _taskType = State(initialValue: draft.flatMap { Self.types.contains($0.taskType) ? $0.taskType : nil } ?? "chore")
        _hasDueDate = State(initialValue: draft == nil || draft?.dueDate != nil)
        _dueDate = State(initialValue: day)
        _hasDueTime = State(initialValue: draftTime != nil)
        _dueTime = State(initialValue: draftTime ?? FamilyDates.calendar.date(bySettingHour: 17, minute: 0, second: 0, of: day) ?? day)
    }

    private var canBeClaimable: Bool { profileId == "family" && taskType == "chore" }

    private var canRotate: Bool {
        taskType == "chore" && hasDueDate && repeatRule != "none"
            && (model.state?.claimants.contains { $0.id == profileId } ?? false)
    }

    private var rotationCandidates: [Profile] {
        (model.state?.claimants ?? []).filter { $0.id != profileId }
    }

    private var rotationProfiles: [String]? {
        let others = rotationCandidates.filter { rotationOthers.contains($0.id) }.map(\.id)
        return canRotate && !others.isEmpty ? [profileId] + others : nil
    }

    private var rotationFooter: String {
        guard let order = rotationProfiles else {
            return "Choose who else takes turns. \(model.state?.profile(profileId)?.name ?? "The chosen person") goes first."
        }
        let names = order.map { model.state?.profile($0)?.name ?? $0 }.joined(separator: " → ")
        return "\(names), then back to the start. It passes to the next person each time it's completed or skipped."
    }

    var body: some View {
        Form {
            Section {
                TextField("Title", text: $title)
                ProfilePicker(selection: $profileId)
                Picker("Type", selection: $taskType) {
                    ForEach(Self.types, id: \.self) { Text($0.capitalized).tag($0) }
                }
                if canBeClaimable {
                    Toggle("Anyone can claim", isOn: $claimable)
                }
            }

            Section {
                Toggle("Due date", isOn: $hasDueDate)
                if hasDueDate {
                    DatePicker("Date", selection: $dueDate, displayedComponents: .date)
                    Toggle("Time", isOn: $hasDueTime)
                    if hasDueTime {
                        DatePicker("Time", selection: $dueTime, displayedComponents: .hourAndMinute)
                    }
                    Picker("Repeat", selection: $repeatRule) {
                        ForEach(Self.repeatRules, id: \.self) { Text($0 == "none" ? "Never" : $0.capitalized).tag($0) }
                    }
                }
            }

            if canRotate {
                Section {
                    ForEach(rotationCandidates) { person in
                        Toggle(isOn: Binding(
                            get: { rotationOthers.contains(person.id) },
                            set: { if $0 { rotationOthers.insert(person.id) } else { rotationOthers.remove(person.id) } }
                        )) {
                            ProfileLabel(profile: person)
                        }
                        // The server allows up to eight people in a rotation.
                        .disabled(!rotationOthers.contains(person.id) && rotationOthers.count >= 7)
                    }
                } header: {
                    Text("Take Turns")
                } footer: {
                    Text(rotationFooter)
                }
            }

            Section {
                Stepper("Stars: \(starValue)", value: $starValue, in: 0...5)
            } footer: {
                Text("Stars are added to the person's reward balance when the task is completed.")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("New Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onComplete)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
            }
        }
    }

    private func save() {
        let payload = TaskPayload(
            title: title.trimmingCharacters(in: .whitespaces),
            profileId: profileId,
            dueDate: hasDueDate ? FamilyDates.dayKey(dueDate) : nil,
            dueTime: hasDueDate && hasDueTime ? FamilyDates.timeKey(dueTime) : nil,
            repeatRule: hasDueDate ? repeatRule : "none",
            starValue: starValue,
            taskType: taskType,
            claimable: canBeClaimable && claimable,
            rotationProfiles: rotationProfiles
        )
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await model.create(.task(payload))
                onSave()
                onComplete()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
