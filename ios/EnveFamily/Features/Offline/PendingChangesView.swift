import SwiftUI

struct PendingChangesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if model.isOffline {
                        Label(offlineMessage, systemImage: "wifi.slash")
                    } else {
                        Label("Connected to \(model.serverAddress)", systemImage: "checkmark.circle")
                    }
                } footer: {
                    Text("While offline you can read the last loaded data and add events, tasks, list items, and meals. They're sent in order when the server is reachable. Other changes need a connection.")
                }

                if model.pendingChanges.isEmpty {
                    Text("Nothing waiting to send.").foregroundStyle(.secondary)
                } else {
                    Section("Waiting to Send") {
                        ForEach(model.pendingChanges) { change in
                            PendingChangeRow(change: change)
                                .swipeActions {
                                    Button("Discard", role: .destructive) { model.removePendingChange(change.id) }
                                }
                        }
                    }
                }
            }
            .refreshable { await model.load() }
            .navigationTitle("Sync Status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var offlineMessage: String {
        if let date = model.cachedStateDate {
            "Offline. Showing data saved \(date.formatted(.relative(presentation: .named)))."
        } else {
            "Offline. Showing the last data loaded."
        }
    }
}

struct PendingChangeRow: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model
    let change: PendingChange

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: change.operation.symbol)
                .foregroundStyle(accent)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(change.operation.title)
                Text(status).font(.footnote).foregroundStyle(isFailed ? Color.red : Color.secondary)
            }
            Spacer(minLength: 0)
            switch change.status {
            case .sending:
                ProgressView()
            case .failed:
                Button("Retry") {
                    let id = change.id
                    Task { await model.retryPendingChange(id) }
                }
                .buttonStyle(.bordered)
            case .waiting:
                Image(systemName: "clock").foregroundStyle(.secondary).accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var isFailed: Bool {
        if case .failed = change.status { true } else { false }
    }

    private var status: String {
        switch change.status {
        case .waiting: "\(change.operation.kindTitle) · Waiting to send"
        case .sending: "\(change.operation.kindTitle) · Sending…"
        case .failed(let message): "\(change.operation.kindTitle) · Not sent. \(message)"
        }
    }
}
