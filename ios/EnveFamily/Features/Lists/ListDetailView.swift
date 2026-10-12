import SwiftUI

struct ListDetailView: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let listId: String
    @State private var newItem = ""
    @State private var newSection = ""
    @State private var isConfirmingDelete = false
    @FocusState private var isAddingItem: Bool

    var body: some View {
        if let list = model.state?.lists.first(where: { $0.id == listId }) {
            content(for: list)
        } else {
            ContentUnavailableView("List Not Found", systemImage: "list.bullet.rectangle")
        }
    }

    private func content(for list: HouseholdList) -> some View {
        let groups = sections(for: list)
        return List {
            if groups.isEmpty {
                Text("Nothing here yet.").foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.items) { item in
                        Button {
                            let id = item.id
                            let checked = !item.checked
                            Task { await model.run { try await $0.setListItem(id, checked: checked) } }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(accent)
                                Text(item.title)
                                    .strikethrough(item.checked)
                                    .foregroundStyle(item.checked ? .secondary : .primary)
                            }
                        }
                        .swipeActions {
                            Button("Delete", role: .destructive) {
                                let id = item.id
                                Task { await model.run { try await $0.deleteListItem(id) } }
                            }
                        }
                    }
                } header: {
                    if !group.title.isEmpty { Text(group.title) }
                }
            }

            let waiting = model.pendingChanges.filter { change in
                guard case .listItem(let id, _, _) = change.operation else { return false }
                return id == list.id
            }
            if !waiting.isEmpty {
                Section("Waiting to Send") {
                    ForEach(waiting) { PendingChangeRow(change: $0) }
                }
            }

            Section("Add Item") {
                TextField("Item", text: $newItem)
                    .focused($isAddingItem)
                    .submitLabel(.done)
                    .onSubmit(addItem)
                TextField("Section (optional)", text: $newSection)
                Button("Add", action: addItem)
                    .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .refreshable { await model.load() }
        .navigationTitle(list.name)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Sort", selection: Binding(
                        get: { ListSortOrder(rawValue: list.sortOrder) ?? .added },
                        set: { [listId] order in Task { await model.run { try await $0.setListSort(listId, to: order) } } }
                    )) {
                        ForEach(ListSortOrder.allCases) { Text($0.title).tag($0) }
                    }
                    if list.id != HouseholdList.groceriesId {
                        Button("Delete List", role: .destructive) { isConfirmingDelete = true }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("List Options")
            }
        }
        .confirmationDialog("Delete \(list.name)?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete List", role: .destructive) {
                let id = listId
                Task {
                    await model.run { try await $0.deleteList(id) }
                    dismiss()
                }
            }
        } message: {
            Text("The list and all its items will be removed.")
        }
    }

    /// Sorted like the web UI, then grouped by section in order of first appearance.
    private func sections(for list: HouseholdList) -> [ItemSection] {
        var items = model.state?.listItems.filter { $0.listId == list.id } ?? []
        switch ListSortOrder(rawValue: list.sortOrder) {
        case .alpha: items.sort { $0.title.localizedCompare($1.title) == .orderedAscending }
        case .checked: items.sort { !$0.checked && $1.checked }
        case .added, nil: break
        }
        var order: [String] = []
        var grouped: [String: [ListItem]] = [:]
        for item in items {
            if grouped[item.section] == nil { order.append(item.section) }
            grouped[item.section, default: []].append(item)
        }
        return order.map { ItemSection(title: $0, items: grouped[$0]!) }
    }

    private func addItem() {
        let title = newItem.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        let section = newSection.trimmingCharacters(in: .whitespaces)
        let listId = listId
        newItem = ""
        isAddingItem = true
        Task {
            do {
                try await model.create(.listItem(listId: listId, title: title, section: section))
            } catch {
                model.banner = error.localizedDescription
            }
        }
    }
}

private struct ItemSection: Identifiable {
    let title: String
    let items: [ListItem]

    var id: String { title }
}
