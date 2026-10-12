import SwiftUI

struct CalendarSearchView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onSelect: (SearchHit) -> Void

    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var errorMessage: String?
    @State private var isSearching = false

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                } else if trimmedQuery.count >= 2, !isSearching, hits.isEmpty {
                    ContentUnavailableView.search(text: trimmedQuery)
                }
                ForEach(hits) { hit in
                    Button { onSelect(hit) } label: { SearchHitRow(hit: hit) }
                        .buttonStyle(.plain)
                        .disabled(hit.date == nil)
                }
            }
            .overlay {
                if isSearching && hits.isEmpty { ProgressView() }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Events, tasks, lists, meals")
            .task(id: trimmedQuery) { await search(trimmedQuery) }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func search(_ text: String) async {
        guard text.count >= 2 else {
            hits = []
            errorMessage = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let json = try await model.call { try await $0.search(text) }
            guard !Task.isCancelled else { return }
            hits = SearchHit.hits(in: json)
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            hits = []
            errorMessage = error.localizedDescription
        }
    }
}

private struct SearchHitRow: View {
    @Environment(\.enveAccent) private var accent
    let hit: SearchHit

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(accent)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(hit.title).font(.body.weight(.medium))
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(hit.date == nil ? "" : "Shows this day in the calendar")
    }

    private var symbol: String {
        switch hit.kind {
        case "event": "calendar"
        case "task", "chore", "routine", "habit": "checklist"
        case "list", "listItem", "item": "list.bullet"
        case "meal": "fork.knife"
        case "recipe": "book"
        default: "magnifyingglass"
        }
    }

    private var subtitle: String {
        let date = hit.date.map {
            hit.allDay ? $0.formatted(date: .abbreviated, time: .omitted) : $0.formatted(date: .abbreviated, time: .shortened)
        }
        return [date, hit.detail ?? hit.kind.capitalized].compactMap { $0 }.joined(separator: " · ")
    }
}
