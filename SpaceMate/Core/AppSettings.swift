import Foundation

enum ReminderFrequency: String, Codable, CaseIterable, Identifiable {
    case off, weekly, monthly
    var id: String { rawValue }

    var label: String {
        switch self {
        case .off: return "Off"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        }
    }

    /// Calendar components for a repeating local notification. Nil when reminders are off.
    func triggerComponents(hour: Int, weekday: Int = 1, dayOfMonth: Int = 1) -> DateComponents? {
        switch self {
        case .off:
            return nil
        case .weekly:
            return DateComponents(hour: hour, minute: 0, weekday: weekday)
        case .monthly:
            return DateComponents(day: dayOfMonth, hour: hour, minute: 0)
        }
    }
}

struct AppSettings: Codable, Equatable {
    var freeSpaceTarget: Int64 = 10 * ByteFormat.gigabyte
    var reminderFrequency: ReminderFrequency = .off
    var reminderHour: Int = 18
    var reminderWeekday: Int = 1
    var largeVideoThreshold: Int64 = 100 * ByteFormat.megabyte
    var largeFileThreshold: Int64 = 50 * ByteFormat.megabyte
    var longScreenRecordingSeconds: Double = 60
}

/// Everything SpaceMate keeps on disk. Contains no file contents or photos, only
/// identifiers, sizes and measurements.
struct AppData: Codable, Equatable {
    var settings = AppSettings()
    var snapshots: [StorageSnapshot] = []
    var sessions: [CleanupSession] = []
    var protectedItems: [ProtectedItem] = []
    var lastMediaAnalysis: Date?
    var lastFileScan: Date?

    static let empty = AppData()
}

/// Permission state for the photo library, independent of PhotoKit so it can be tested.
enum MediaAccess: Equatable {
    case notDetermined, denied, restricted, limited, full

    var canAnalyze: Bool { self == .limited || self == .full }

    var title: String {
        switch self {
        case .notDetermined: return "Photo access not requested yet"
        case .denied: return "Photo access is off"
        case .restricted: return "Photo access is restricted"
        case .limited: return "Limited photo access"
        case .full: return "Full photo access"
        }
    }

    var message: String {
        switch self {
        case .notDetermined:
            return "SpaceMate analyzes photos and videos on this iPhone to find large videos, screenshots and look-alike shots. Nothing is uploaded."
        case .denied:
            return "You turned off photo access. To analyze media, open Settings → Apps → SpaceMate → Photos and choose Full Access (or Limited Access)."
        case .restricted:
            return "Photo access is blocked by a restriction on this device (for example Screen Time or a device profile). SpaceMate can't change this."
        case .limited:
            return "SpaceMate can only see the photos you selected, so results cover just those items. You can add more photos or allow full access in Settings."
        case .full:
            return "SpaceMate can analyze your whole photo library. Everything stays on this iPhone."
        }
    }
}
