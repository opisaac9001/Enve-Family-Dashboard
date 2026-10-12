import SwiftUI

struct EventDetailView: View {
    private enum SeriesAction: Identifiable {
        case edit, delete

        var id: Self { self }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let event: CalendarEvent
    @State private var path: [EventScope] = []
    @State private var seriesAction: SeriesAction?
    @State private var isConfirmingDelete = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(event.indicatorColor(profile: model.state?.profile(event.profileId)))
                            .frame(width: 4)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.title).font(.title2.bold())
                            Text(event.fullTimeDescription).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    LabeledContent("Person") { ProfileLabel(profile: model.state?.profile(event.profileId)) }
                    LabeledContent("Calendar", value: event.calendarName ?? event.source.title)
                    if let repeatRule = event.repeatRule {
                        LabeledContent("Repeats", value: repeatRule.capitalized)
                    }
                }

                if !event.notes.isEmpty {
                    Section("Notes") {
                        Text(event.notes)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }

                if event.location != nil {
                    Section {
                        Button("Edit Event") {
                            if event.isRecurring { seriesAction = .edit } else { path.append(.series) }
                        }
                        Button("Delete Event", role: .destructive) {
                            if event.isRecurring { seriesAction = .delete } else { isConfirmingDelete = true }
                        }
                    }
                } else {
                    Section {
                        Text("This calendar is read-only here. Change it in \(event.source.title).")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: EventScope.self) { scope in
                EventEditorView(editing: event, scope: scope, day: event.startDate) { dismiss() }
            }
            .confirmationDialog(
                seriesAction == .edit ? "Edit Repeating Event" : "Delete Repeating Event",
                isPresented: Binding(get: { seriesAction != nil }, set: { if !$0 { seriesAction = nil } }),
                titleVisibility: .visible,
                presenting: seriesAction
            ) { action in
                switch action {
                case .edit:
                    Button("This Event Only") { path.append(.occurrence) }
                    Button("All Events") { path.append(.series) }
                case .delete:
                    Button("Delete This Event Only", role: .destructive) { delete(scope: .occurrence) }
                    Button("Delete All Events", role: .destructive) { delete(scope: .series) }
                }
            }
            .confirmationDialog("Delete Event?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { delete(scope: .series) }
            } message: {
                Text("This event will be removed from its calendar.")
            }
        }
    }

    private func delete(scope: EventScope) {
        guard let location = event.location else { return }
        errorMessage = nil
        Task {
            do {
                try await model.mutate { try await $0.deleteEvent(at: location, scope: scope) }
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
