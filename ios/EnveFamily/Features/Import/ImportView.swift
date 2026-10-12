import PhotosUI
import SwiftUI

struct ImportView: View {
    @Environment(\.enveAccent) private var accent
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var kind: ImportKind = .event
    @State private var text = ""
    @State private var drafts: [ImportDraft] = []
    @State private var listItems: [ListDraftItem] = []
    @State private var listId = HouseholdList.groceriesId
    @State private var listSection = ""
    @State private var status: String?
    @State private var isReading = false
    @State private var isSavingList = false
    @State private var isShowingCamera = false
    @State private var isShowingFiles = false
    @State private var photoItem: PhotosPickerItem?
    @State private var reviewing: ImportDraft?
    /// The shared item the shown drafts came from; it's removed from the inbox once they're all saved.
    @State private var activeShareID: UUID?
    @State private var dictation = SpeechDictation()
    /// Text already in the field when dictation started; the live transcript is appended to it.
    @State private var dictationPrefix = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Import as", selection: $kind) {
                        ForEach(ImportKind.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(kind.hint)
                }
                .disabled(isReading)

                sharedSection

                Section {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { isShowingCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                    }
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        Label("Choose Photo", systemImage: "photo.on.rectangle")
                    }
                    Button { isShowingFiles = true } label: { Label("Choose File", systemImage: "doc") }
                } footer: {
                    Text("PDF, photo, or text file up to 5 MB. Nothing is saved until you review it.")
                }
                .disabled(isReading)

                Section {
                    TextField("Paste, type, or dictate text", text: $text, axis: .vertical)
                        .lineLimit(4...12)
                        .disabled(dictation.isRecording)
                    Button(action: toggleDictation) {
                        Label(dictation.isRecording ? "Stop Dictating" : "Dictate",
                              systemImage: dictation.isRecording ? "stop.circle.fill" : "mic")
                    }
                    .disabled(isReading)
                    Button("Find Drafts") {
                        dictation.stop()
                        read(.editedText) { .text(text) }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isReading)
                } header: {
                    Text("Text")
                } footer: {
                    if let error = dictation.errorMessage {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("Text read from a photo or file, or dictated on this iPhone, appears here so you can correct it and find drafts again.")
                    }
                }

                if isReading {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Reading and finding drafts…").foregroundStyle(.secondary)
                        }
                    }
                } else if let status {
                    Section {
                        Text(status).font(.callout)
                    }
                }

                if kind == .list {
                    listDraftSections
                } else if !drafts.isEmpty {
                    Section {
                        ForEach(drafts) { draft in
                            Button { reviewing = draft } label: { DraftRow(draft: draft) }
                                .buttonStyle(.plain)
                                .swipeActions {
                                    Button("Discard", role: .destructive) { drafts.removeAll { $0.id == draft.id } }
                                }
                        }
                    } header: {
                        Text("Drafts")
                    } footer: {
                        Text("Tap a draft to review and save it. Swipe to discard.")
                    }
                }
            }
            .navigationTitle("Import")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: kind) {
                drafts = []
                listItems = []
                status = nil
            }
            .onChange(of: dictation.transcript) {
                guard !dictation.transcript.isEmpty else { return }
                text = dictationPrefix.isEmpty ? dictation.transcript : dictationPrefix + "\n" + dictation.transcript
            }
            .onChange(of: scenePhase) {
                if scenePhase != .active { dictation.stop() }
            }
            .onDisappear { dictation.stop() }
            .onChange(of: photoItem) {
                guard let item = photoItem else { return }
                photoItem = nil
                read(.newSource) {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw ImportFileError.unreadable }
                    return try await Task.detached { try ImportFiles.source(fromPhotoData: data) }.value
                }
            }
            .fileImporter(isPresented: $isShowingFiles, allowedContentTypes: ImportFiles.allowedTypes) { result in
                guard case .success(let url) = result else { return }
                read(.newSource) { try await Task.detached { try ImportFiles.source(fromFile: url) }.value }
            }
            .fullScreenCover(isPresented: $isShowingCamera) {
                CameraPicker { image in
                    isShowingCamera = false
                    guard let image else { return }
                    read(.newSource) { try await Task.detached { try ImportFiles.source(from: image) }.value }
                }
                .ignoresSafeArea()
            }
            .sheet(item: $reviewing) { draft in
                NavigationStack {
                    editor(for: draft)
                }
                .pinPromptHost(level: 2)
            }
        }
    }

    @ViewBuilder
    private var sharedSection: some View {
        if !model.pendingShares.isEmpty || !model.unreadableShareIDs.isEmpty || model.shareInboxError != nil {
            Section {
                ForEach(model.pendingShares) { share in
                    SharedItemRow(
                        share: share,
                        isActive: share.id == activeShareID,
                        isBusy: isReading || model.sharesBeingRead.contains(share.id),
                        onRead: { readShare(share) }
                    )
                    .swipeActions {
                        Button("Discard", role: .destructive) { discardShare(share.id) }
                    }
                }
                ForEach(model.unreadableShareIDs, id: \.self) { id in
                    HStack {
                        Label("A shared item couldn't be read", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(accent)
                        Spacer()
                        Button("Discard", role: .destructive) { discardShare(id) }
                            .buttonStyle(.borderless)
                    }
                }
            } header: {
                Text("Shared to Enve Family")
            } footer: {
                if let error = model.shareInboxError {
                    Text(error).foregroundStyle(.red)
                } else {
                    Text("Choose what to import it as, then Find Drafts. A shared item stays here until its drafts are saved or you swipe to discard it.")
                }
            }
        }
    }

    @ViewBuilder
    private var listDraftSections: some View {
        if !listItems.isEmpty {
            Section {
                Picker("List", selection: $listId) {
                    ForEach(model.state?.lists ?? []) { Text($0.name).tag($0.id) }
                }
                TextField("Section (optional)", text: $listSection)
            }

            Section {
                ForEach($listItems) { $item in
                    TextField("Item", text: $item.title)
                }
                .onDelete { listItems.remove(atOffsets: $0) }
                Button(isSavingList ? "Adding…" : "Add \(savableListItems.count) to \(listName)", action: saveListItems)
                    .disabled(savableListItems.isEmpty || isSavingList)
            } header: {
                Text("Items")
            } footer: {
                Text("Edit or swipe to remove items before adding them.")
            }
        }
    }

    @ViewBuilder
    private func editor(for draft: ImportDraft) -> some View {
        let onSave = { drafted(draft) }
        let onComplete = { reviewing = nil }
        switch draft.content {
        case .event(let event):
            EventEditorView(editing: nil, scope: .series, day: event.start, draft: event, onSave: onSave, onComplete: onComplete)
        case .task(let task):
            TaskEditorView(draft: task, onSave: onSave, onComplete: onComplete)
        case .recipe(let recipe):
            RecipeEditorView(recipe: nil, draft: recipe, onSave: onSave, onComplete: onComplete)
        case .listItem:
            EmptyView()
        }
    }

    private var savableListItems: [ListDraftItem] {
        listItems.filter { !$0.trimmedTitle.isEmpty }
    }

    private var listName: String {
        model.state?.lists.first { $0.id == listId }?.name ?? "List"
    }

    private func toggleDictation() {
        if dictation.isRecording {
            dictation.stop()
        } else {
            dictationPrefix = text.trimmingCharacters(in: .whitespacesAndNewlines)
            Task { await dictation.start() }
        }
    }

    private func readShare(_ share: PendingShare) {
        guard !isReading, model.beginReadingShare(share.id) else { return }
        dictation.stop()
        read(.share(share.id)) { try await Task.detached { try ImportFiles.source(fromShare: share) }.value }
    }

    private func discardShare(_ id: UUID) {
        do {
            try model.discardShare(id)
            if activeShareID == id { activeShareID = nil }
        } catch {
            status = error.localizedDescription
        }
    }

    /// Called once every draft from the active shared item has been saved.
    private func completeActiveShare() -> String {
        guard let id = activeShareID else { return "" }
        activeShareID = nil
        do {
            try model.discardShare(id)
            return ""
        } catch {
            return " The shared item couldn't be removed: \(error.localizedDescription)"
        }
    }

    private func read(_ origin: ReadOrigin, _ prepare: @escaping @MainActor () async throws -> ImportSource) {
        let kind = kind
        status = nil
        isReading = true
        Task {
            do {
                let source = try await prepare()
                let result = try await model.callUnlocked { try await $0.importDrafts(kind, source: source) }
                apply(result)
                switch origin {
                case .editedText: break
                case .newSource: activeShareID = nil
                case .share(let id): activeShareID = id
                }
            } catch {
                status = error.localizedDescription
            }
            if case .share(let id) = origin { model.finishReadingShare(id) }
            isReading = false
        }
    }

    private func apply(_ result: ImportResult) {
        text = result.text
        if kind == .list {
            listItems = result.drafts.compactMap { draft -> ListDraftItem? in
                guard case .listItem(let title) = draft.content else { return nil }
                return ListDraftItem(title: title)
            }
            drafts = []
        } else {
            drafts = result.drafts
            listItems = []
        }
        let count = result.drafts.count
        status = result.message ?? (count == 0
            ? "Nothing recognizable was found. Edit the text and try again."
            : "\(count) draft\(count == 1 ? "" : "s") found. Review each before saving.")
    }

    private func drafted(_ draft: ImportDraft) {
        drafts.removeAll { $0.id == draft.id }
        status = drafts.isEmpty ? "All drafts saved." + completeActiveShare() : "Saved. Review the remaining drafts."
    }

    private func saveListItems() {
        let items = savableListItems
        let listId = listId
        let listName = listName
        let section = listSection.trimmingCharacters(in: .whitespaces)
        isSavingList = true
        Task {
            var added = 0
            do {
                for item in items {
                    let title = item.trimmedTitle
                    try await model.callUnlocked { try await $0.addListItem(to: listId, title: title, section: section) }
                    listItems.removeAll { $0.id == item.id }
                    added += 1
                }
                status = "Added \(added) item\(added == 1 ? "" : "s") to \(listName)." + (listItems.isEmpty ? completeActiveShare() : "")
            } catch {
                status = added == 0 ? error.localizedDescription : "Added \(added) of \(items.count) items. \(error.localizedDescription)"
            }
            await model.load()
            isSavingList = false
        }
    }
}

private enum ReadOrigin {
    /// The text field, which may still hold text read from the active shared item.
    case editedText
    case newSource
    case share(UUID)
}

private struct SharedItemRow: View {
    @Environment(\.enveAccent) private var accent
    let share: PendingShare
    let isActive: Bool
    let isBusy: Bool
    let onRead: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(accent)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(share.title).lineLimit(2)
                Text("\(kindName) · Shared \(share.createdAt.formatted(.relative(presentation: .named)))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button(isActive ? "Find Again" : "Find Drafts", action: onRead)
                .buttonStyle(.borderless)
                .disabled(isBusy)
        }
    }

    private var symbol: String {
        switch share.kind {
        case .text: "text.alignleft"
        case .pdf: "doc.richtext"
        case .image: "photo"
        }
    }

    private var kindName: String {
        switch share.kind {
        case .text: "Text"
        case .pdf: "PDF"
        case .image: "Photo"
        }
    }
}

private struct ListDraftItem: Identifiable {
    let id = UUID()
    var title: String

    var trimmedTitle: String { title.trimmingCharacters(in: .whitespaces) }
}

private struct DraftRow: View {
    @Environment(\.enveAccent) private var accent
    let draft: ImportDraft

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(accent)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the draft for review")
    }

    private var symbol: String {
        switch draft.content {
        case .event: "calendar"
        case .task: "checklist"
        case .listItem: "list.bullet"
        case .recipe: "fork.knife"
        }
    }

    private var title: String {
        switch draft.content {
        case .event(let event): event.title
        case .task(let task): task.title
        case .listItem(let title): title
        case .recipe(let recipe): recipe.title
        }
    }

    private var detail: String {
        switch draft.content {
        case .event(let event):
            event.allDay
                ? "\(event.start.formatted(date: .abbreviated, time: .omitted)) · All day"
                : event.start.formatted(date: .abbreviated, time: .shortened)
        case .task(let task):
            task.dueDate.map { "Due \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "No due date"
        case .listItem:
            "List item"
        case .recipe(let recipe):
            "\(recipe.ingredients.split(separator: "\n").count) ingredients"
        }
    }
}

private extension ImportKind {
    var hint: String {
        switch self {
        case .event: "Flyers, invitations, school calendars, or .ics files."
        case .task: "A note or message about something to do."
        case .list: "One item per line, like a handwritten grocery list."
        case .recipe: "A recipe with an Ingredients heading, and optionally Directions."
        }
    }
}
