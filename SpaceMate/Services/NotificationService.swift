import Foundation
import UserNotifications

/// Schedules local review reminders. SpaceMate can't watch storage in the background,
/// so reminders are time-based and the free-space check happens when the app is opened.
enum NotificationService {
    static let reminderID = "spacemate.review-reminder"

    static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Replaces any existing reminder. Returns false if notifications aren't allowed.
    @discardableResult
    static func schedule(_ settings: AppSettings) async -> Bool {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [reminderID])
        guard let components = settings.reminderFrequency.triggerComponents(hour: settings.reminderHour, weekday: settings.reminderWeekday) else {
            return true
        }
        let status = await authorizationStatus()
        guard status == .authorized || status == .provisional else { return false }

        let content = UNMutableNotificationContent()
        content.title = "Storage check-in"
        content.body = "Take a minute to review large videos, downloads and your free space in SpaceMate."
        content.sound = .default
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
        do {
            try await center.add(UNNotificationRequest(identifier: reminderID, content: content, trigger: trigger))
            return true
        } catch {
            return false
        }
    }

    static func cancelAll() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [reminderID])
    }
}
