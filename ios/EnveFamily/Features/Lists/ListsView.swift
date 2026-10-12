import SwiftUI

struct ListsView: View {
    @Environment(AppModel.self) private var model
    @State private var isNaming = false
    @State private var newListName = ""
    @State private var listToDelete: HouseholdList?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.state?.lists ?? []) { list in
                    let items = model.state?.listItems.filter { $0.listId == list.id } ?? []
                    NavigationLink(value: list.id) {
                        LabeledContent(list.name, value: items.isEmpty ? "Empty" : "\(items.filter { !$0.checked }.count) of \(items.count) left")
                    }
                    .swipeActions {
                        if list.id != HouseholdList.groceriesId {
                            Button("Delete", role: .destructive) { listToDelete = list }
                        }
                    }
                }
            }
            .refreshable { await model.load() }
            .navigationTitle("Lists")
            .navigationDestination(for: String.self) { ListDetailView(listId: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { SettingsButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        newListName = ""
                        isNaming = true
                    } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New List")
                }
            }
            .alert("New List", isPresented: $isNaming) {
                TextField("Name", text: $newListName)
                Button("Cancel", role: .cancel) {}
                Button("Create") {
                    let name = newListName.trimmingCharacters(in: .whitespaces)
                    guard !name.isEmpty else { return }
                    Task { await model.run { try await $0.createList(named: name) } }
                }
            }
            .confirmationDialog("Delete List?", isPresented: Binding(get: { listToDelete != nil }, set: { if !$0 { listToDelete = nil } }),
                                titleVisibility: .visible, presenting: listToDelete) { list in
                Button("Delete \(list.name)", role: .destructive) {
                    let id = list.id
                    Task { await model.run { try await $0.deleteList(id) } }
                }
            } message: { _ in
                Text("The list and all its items will be removed.")
            }
        }
    }
}
