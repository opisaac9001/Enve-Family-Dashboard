import Foundation
import Observation
@preconcurrency import UserNotifications

/// Schedules local notifications for timed events and tasks in each loaded `/api/state` range.
@MainActor
@Observable
final class ReminderScheduler {
    private static let enabledKey = "remindersOnThisDevice"
    private static let prefix = "enve.reminder."
    // iOS keeps at most 64 pending requests per app.
    private static let limit = 60

    private(set) var isEnabledOnDevice: Bool {
        didSet { UserDefaults.standard.set(isEnabledOnDevice, forKey: Self.enabledKey) }
    }
    private(set) var authorization: UNAuthorizationStatus = .notDetermined

    private let center = UNUserNotificationCenter.current()

    init() {
        isEnabledOnDevice = UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    func refreshAuthorization() async {
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Turns reminders on for this device, asking for notification permission when needed. Returns whether they're on.
    func enable() async -> Bool {
        await refreshAuthorization()
        if authorization == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            await refreshAuthorization()
        }
        isEnabledOnDevice = [.authorized, .provisional, .ephemeral].contains(authorization)
        return isEnabledOnDevice
    }

    func disable() async {
        isEnabledOnDevice = false
        await removeAll()
    }

    func removeAll() async {
        let ours = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.prefix) }
        center.removePendingNotificationRequests(withIdentifiers: ours)
    }

    /// Requests whose item falls inside `range` are replaced by `state`; ones outside it are kept until that range is loaded.
    func update(with state: FamilyState, range: (from: Date, to: Date)) async {
        await refreshAuthorization()
        let settings = HouseholdSettings(values: state.settings)
        guard isEnabledOnDevice, settings.remindersEnabled, [.authorized, .provisional, .ephemeral].contains(authorization) else {
            await removeAll()
            return
        }
        let minutes = settings.reminderMinutes
        let now = Date.now
        let existing = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(Self.prefix) }

        let loaded = reminders(in: state, minutes: minutes).filter { $0.fireDate > now }
        let loadedIds = Set(loaded.map(\.id))
        let kept = existing.compactMap(Reminder.init(request:)).filter { reminder in
            reminder.minutes == minutes && reminder.fireDate > now && !loadedIds.contains(reminder.id)
                && !(range.from..<range.to).contains(reminder.itemDate)
        }
        let wanted = (kept + loaded).sorted { $0.fireDate < $1.fireDate }.prefix(Self.limit)

        let wantedIds = Set(wanted.map(\.id))
        center.removePendingNotificationRequests(withIdentifiers: existing.map(\.identifier).filter { !wantedIds.contains($0) })

        let current = Dictionary(existing.compactMap(Reminder.init(request:)).map { ($0.id, $0) }) { first, _ in first }
        for reminder in wanted where current[reminder.id] != reminder {
            try? await center.add(reminder.request)
        }
    }

    private func reminders(in state: FamilyState, minutes: Int) -> [Reminder] {
        let names = Dictionary(state.profiles.map { ($0.id, $0.name) }) { first, _ in first }
        let events = state.events.filter { !$0.allDay }.map { event in
            Reminder(id: Self.prefix + "event." + event.id, title: event.title,
                     body: Self.body(prefix: "Starts", at: event.startDate, person: names[event.profileId]),
                     itemDate: event.startDate, minutes: minutes)
        }
        let tasks = state.tasks.compactMap { task -> Reminder? in
            guard !task.completed, !task.skipped, let dueDate = task.dueDate, let dueTime = task.dueTime,
                  let day = FamilyDates.day(fromKey: dueDate), let due = FamilyDates.time(fromKey: dueTime, on: day) else { return nil }
            return Reminder(id: Self.prefix + "task." + task.id, title: task.title,
                            body: Self.body(prefix: "Due", at: due, person: names[task.claimedBy ?? task.profileId]),
                            itemDate: due, minutes: minutes)
        }
        return events + tasks
    }

    private static func body(prefix: String, at date: Date, person: String?) -> String {
        let time = "\(prefix) at \(date.formatted(date: .omitted, time: .shortened))"
        return person.map { "\(time) · \($0)" } ?? time
    }
}

private struct Reminder: Equatable {
    let id: String
    let title: String
    let body: String
    let itemDate: Date
    let minutes: Int

    var fireDate: Date { itemDate.addingTimeInterval(-Double(minutes) * 60) }

    init(id: String, title: String, body: String, itemDate: Date, minutes: Int) {
        self.id = id
        self.title = title
        self.body = body
        self.itemDate = itemDate
        self.minutes = minutes
    }

    init?(request: UNNotificationRequest) {
        guard let at = request.content.userInfo["itemDate"] as? Double, let minutes = request.content.userInfo["minutes"] as? Int else { return nil }
        self.init(id: request.identifier, title: request.content.title, body: request.content.body,
                  itemDate: Date(timeIntervalSince1970: at), minutes: minutes)
    }

    var request: UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["itemDate": itemDate.timeIntervalSince1970, "minutes": minutes]
        let components = FamilyDates.calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireDate)
        return UNNotificationRequest(identifier: id, content: content,
                                     trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false))
    }
}
