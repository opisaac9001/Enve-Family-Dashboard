import Foundation
import Observation

enum ConnectionPhase: Equatable {
    case setup
    case connecting
    case needsLogin
    case failed(String)
    case ready
}

@MainActor
@Observable
final class AppModel {
    static let defaultServer = "http://127.0.0.1:4317"
    private static let serverKey = "serverURL"

    private(set) var phase: ConnectionPhase
    private(set) var state: FamilyState?
    private(set) var client: APIClient?
    private(set) var isLoading = false
    /// Set when the last state load couldn't reach the server; `state` is then the last good copy.
    private(set) var isOffline = false
    /// When `state` came from the offline cache, the time it was saved.
    private(set) var cachedStateDate: Date?
    private(set) var allPendingChanges: [PendingChange]
    let reminders = ReminderScheduler()
    var banner: String?
    var isShowingSettings = false
    var isShowingPendingChanges = false
    var isShowingImport = false

    /// Items saved by the share extension, waiting to be imported or discarded.
    private(set) var pendingShares: [PendingShare] = []
    private(set) var unreadableShareIDs: [UUID] = []
    private(set) var shareInboxError: String?
    /// Shares with an import request in flight, so the same share is never sent twice at once.
    private(set) var sharesBeingRead: Set<UUID> = []
    @ObservationIgnored private var announcedShareIDs: Set<UUID> = []

    var cursor = Date.now
    var calendarMode: CalendarMode = .week
    var hiddenProfiles: Set<String> = []

    var isPinPromptPresented = false
    var pinError: String?
    /// Number of presented sheets, so the PIN prompt is shown from the topmost one.
    var sheetDepth = 0
    @ObservationIgnored private var pinContinuation: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var lastLoadStart = Date.distantPast
    @ObservationIgnored private var pendingLiveRefresh: Task<Void, Never>?
    @ObservationIgnored private var isReplaying = false
    /// The range of the last state that came from the server, which reminders are scheduled against.
    @ObservationIgnored private var loadedRange: (from: Date, to: Date)?

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.serverKey), let url = Self.serverURL(from: saved) {
            client = APIClient(baseURL: url)
            phase = .connecting
        } else {
            phase = .setup
        }
        allPendingChanges = OfflineStore.pendingChanges().map { change in
            guard change.status == .sending else { return change }
            var interrupted = change
            interrupted.status = .failed("Sending was interrupted. Check whether it was saved before trying again.")
            return interrupted
        }
    }

    var serverAddress: String {
        client?.baseURL.absoluteString ?? UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
    }

    var hasSavedSignIn: Bool {
        client.map { KeychainStore.credentials(for: $0.baseURL) != nil } ?? false
    }

    static func serverURL(from text: String) -> URL? {
        guard var components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty else { return nil }
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        return components.url
    }

    // MARK: Connection

    func start() async {
        if phase == .connecting { await load() }
    }

    func connect(to address: String) async {
        guard let url = Self.serverURL(from: address) else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        client = APIClient(baseURL: url)
        state = nil
        loadedRange = nil
        isOffline = false
        phase = .connecting
        await reminders.removeAll()
        await load()
    }

    func retry() async {
        guard client != nil else {
            phase = .setup
            return
        }
        phase = .connecting
        await load()
    }

    func changeServer() {
        isShowingSettings = false
        state = nil
        isOffline = false
        phase = .setup
    }

    func signIn(username: String?, password: String) async throws {
        guard let client else { return }
        try await client.login(username: username, password: password)
        try KeychainStore.save(LoginCredentials(username: username, password: password), for: client.baseURL)
        phase = .connecting
        await load()
    }

    func forgetSignIn() async {
        guard let client else { return }
        KeychainStore.delete(for: client.baseURL)
        OfflineStore.clearState()
        await client.clearSession()
        await reminders.removeAll()
        isShowingSettings = false
        state = nil
        isOffline = false
        phase = .needsLogin
    }

    func load() async {
        guard let client else { return }
        loadGeneration += 1
        let generation = loadGeneration
        let range = loadRange
        lastLoadStart = .now
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }
        do {
            let data = try await call { try await $0.stateData(from: FamilyDates.dayKey(range.from), to: FamilyDates.dayKey(range.to)) }
            let state = try Self.decodeState(data)
            guard generation == loadGeneration, client === self.client else { return }
            self.state = state
            loadedRange = range
            cachedStateDate = nil
            isOffline = false
            phase = .ready
            OfflineStore.saveState(data, for: client.baseURL)
            if allPendingChanges.contains(where: { $0.server == client.baseURL.absoluteString && $0.status == .waiting }) {
                Task { await replayPendingChanges() }
            }
            await reminders.update(with: state, range: range)
        } catch {
            guard generation == loadGeneration, client === self.client else { return }
            if let apiError = error as? APIError, case .unauthorized = apiError {
                phase = .needsLogin
            } else if let apiError = error as? APIError, case .unreachable = apiError {
                isOffline = true
                if self.state == nil, let cached = OfflineStore.cachedState(for: client.baseURL), let state = try? Self.decodeState(cached.data) {
                    self.state = state
                    cachedStateDate = cached.savedAt
                    phase = .ready
                } else if self.state == nil {
                    phase = .failed(error.localizedDescription)
                }
            } else if self.state == nil {
                phase = .failed(error.localizedDescription)
            } else {
                banner = error.localizedDescription
            }
        }
    }

    private static func decodeState(_ data: Data) throws -> FamilyState {
        do {
            return try JSONDecoder().decode(FamilyState.self, from: data)
        } catch {
            throw APIError.invalidResponse
        }
    }

    // MARK: Offline creates

    var pendingChanges: [PendingChange] {
        allPendingChanges.filter { $0.server == client?.baseURL.absoluteString }
    }

    /// Creates something on the server, or queues it when the server is unreachable and the request never left the phone.
    /// A request that might have arrived (for example a timeout) is reported as an error rather than queued.
    func create(_ operation: PendingOperation) async throws {
        if !isOffline {
            do {
                try await mutate { try await operation.send(with: $0) }
                return
            } catch let error as APIError where error.requestWasNotSent {
                isOffline = true
            }
        }
        guard let client else { throw APIError.unauthorized("Choose a server to continue.") }
        let change = PendingChange(id: UUID(), server: client.baseURL.absoluteString, createdAt: .now, operation: operation, status: .waiting)
        try savePending(allPendingChanges + [change])
        Task { await load() }
    }

    func retryPendingChange(_ id: UUID) async {
        guard let change = allPendingChanges.first(where: { $0.id == id }) else { return }
        setStatus(.sending, for: id)
        do {
            try await callUnlocked { try await change.operation.send(with: $0) }
            removePendingChange(id)
            await load()
        } catch let error as APIError where error.requestWasNotSent {
            setStatus(.waiting, for: id)
            isOffline = true
            banner = error.localizedDescription
        } catch {
            setStatus(.failed(error.localizedDescription), for: id)
        }
    }

    func removePendingChange(_ id: UUID) {
        do {
            try savePending(allPendingChanges.filter { $0.id != id })
        } catch {
            banner = error.localizedDescription
        }
    }

    /// Sends waiting creates in order. Each is marked as sending on disk first, so an interrupted send is never retried silently.
    private func replayPendingChanges() async {
        guard !isReplaying else { return }
        isReplaying = true
        defer { isReplaying = false }
        var sentAny = false
        for change in pendingChanges where change.status == .waiting {
            guard setStatus(.sending, for: change.id) else { break }
            do {
                try await call { try await change.operation.send(with: $0) }
                removePendingChange(change.id)
                sentAny = true
            } catch let error as APIError where error.requestWasNotSent {
                setStatus(.waiting, for: change.id)
                isOffline = true
                break
            } catch {
                setStatus(.failed(error.localizedDescription), for: change.id)
            }
        }
        if sentAny { await load() }
    }

    @discardableResult
    private func setStatus(_ status: PendingChange.Status, for id: UUID) -> Bool {
        var changes = allPendingChanges
        guard let index = changes.firstIndex(where: { $0.id == id }) else { return false }
        changes[index].status = status
        do {
            try savePending(changes)
            return true
        } catch {
            banner = error.localizedDescription
            return false
        }
    }

    private func savePending(_ changes: [PendingChange]) throws {
        try OfflineStore.savePendingChanges(changes)
        allPendingChanges = changes
    }

    func refreshReminders() async {
        guard let state, let loadedRange else { return }
        await reminders.update(with: state, range: loadedRange)
    }

    // MARK: Shared items

    /// Reloads the share inbox and opens Import once for newly shared items when nothing else is presented.
    func refreshPendingShares() {
        ShareInbox.removeAbandonedStaging()
        do {
            let listing = try ShareInbox.listing()
            pendingShares = listing.shares
            unreadableShareIDs = listing.unreadable
            shareInboxError = nil
        } catch {
            shareInboxError = error.localizedDescription
            return
        }
        let ids = Set(pendingShares.map(\.id) + unreadableShareIDs)
        guard phase == .ready, sheetDepth == 0, !isShowingImport else { return }
        if !ids.isSubset(of: announcedShareIDs) { isShowingImport = true }
        announcedShareIDs = ids
    }

    func discardShare(_ id: UUID) throws {
        try ShareInbox.remove(id)
        pendingShares.removeAll { $0.id == id }
        unreadableShareIDs.removeAll { $0 == id }
    }

    func beginReadingShare(_ id: UUID) -> Bool {
        sharesBeingRead.insert(id).inserted
    }

    func finishReadingShare(_ id: UUID) {
        sharesBeingRead.remove(id)
    }

    // MARK: Live updates

    func watchChanges() async {
        var delay = 2
        var isReconnect = false
        while !Task.isCancelled {
            let reconnect = isReconnect
            let started = Date.now
            _ = try? await call { client in
                try await client.streamChanges { signal in
                    await self.handle(signal, reconnect: reconnect)
                }
            }
            if Task.isCancelled { return }
            if Date.now.timeIntervalSince(started) > 30 { delay = 2 }
            isReconnect = true
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }

    private func handle(_ signal: ChangeSignal, reconnect: Bool) {
        switch signal {
        case .connected where reconnect, .refresh:
            scheduleLiveRefresh()
        case .connected:
            break
        }
    }

    /// Coalesces bursts of change signals and skips the reload when one already started after the signal arrived.
    private func scheduleLiveRefresh() {
        guard pendingLiveRefresh == nil else { return }
        let receivedAt = Date.now
        pendingLiveRefresh = Task {
            try? await Task.sleep(for: .milliseconds(500))
            pendingLiveRefresh = nil
            if !Task.isCancelled, lastLoadStart < receivedAt { await load() }
        }
    }

    // MARK: Requests

    /// Signs in again after a server restart, when its in-memory session is gone.
    func call<T: Sendable>(_ operation: @Sendable (APIClient) async throws -> T) async throws -> T {
        guard let client else { throw APIError.unauthorized("Choose a server to continue.") }
        do {
            return try await operation(client)
        } catch APIError.unauthorized(let message) {
            guard let credentials = KeychainStore.credentials(for: client.baseURL) else { throw APIError.unauthorized(message) }
            try await client.login(username: credentials.username, password: credentials.password)
            return try await operation(client)
        }
    }

    /// Runs a request, prompting for the edit PIN when the server reports edits are locked.
    func callUnlocked<T: Sendable>(_ operation: @Sendable (APIClient) async throws -> T) async throws -> T {
        do {
            return try await call(operation)
        } catch APIError.locked {
            guard await requestPinUnlock() else { throw APIError.locked }
            return try await call(operation)
        }
    }

    /// Performs a change through `callUnlocked`, then reloads.
    @discardableResult
    func mutate<T: Sendable>(_ operation: @Sendable (APIClient) async throws -> T) async throws -> T {
        let result = try await callUnlocked(operation)
        await load()
        return result
    }

    /// Fire-and-report variant of `mutate` for inline actions without their own error UI. Returns whether it succeeded.
    @discardableResult
    func run(_ operation: @Sendable (APIClient) async throws -> Void) async -> Bool {
        do {
            try await mutate(operation)
            return true
        } catch {
            banner = error.localizedDescription
            return false
        }
    }

    // MARK: Edit PIN

    func submitPin(_ pin: String) async {
        guard let client else { return }
        do {
            try await client.unlockPin(pin)
            finishPinPrompt(unlocked: true)
        } catch {
            pinError = error.localizedDescription
        }
    }

    func cancelPinPrompt() {
        finishPinPrompt(unlocked: false)
    }

    private func requestPinUnlock() async -> Bool {
        pinContinuation?.resume(returning: false)
        return await withCheckedContinuation { continuation in
            pinContinuation = continuation
            pinError = nil
            isPinPromptPresented = true
        }
    }

    private func finishPinPrompt(unlocked: Bool) {
        isPinPromptPresented = false
        pinContinuation?.resume(returning: unlocked)
        pinContinuation = nil
    }
}
