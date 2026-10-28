import Foundation

/// A completed cleanup, with both the app's estimate and the device's measured change.
struct CleanupSession: Codable, Identifiable, Hashable {
    enum Source: String, Codable {
        case photos, files
    }

    var id = UUID()
    var date: Date
    var source: Source
    var itemCount: Int
    var estimated: ByteEstimate
    var before: StorageSnapshot?
    var after: StorageSnapshot?
    var note: String?

    /// Change in available space measured by iOS. Includes any other activity on the phone
    /// in between, and Photos deletions don't free space until Recently Deleted is emptied.
    var measuredChange: Int64? {
        guard let before, let after else { return nil }
        return StorageMath.measuredChange(before: before, after: after)
    }
}

struct RecoverySummary: Equatable {
    var sessions: Int
    var itemsRemoved: Int
    var estimatedBytes: Int64
    /// Sum of positive measured changes only. Negative readings mean other activity used space.
    var measuredBytes: Int64
    var sessionsWithMeasurement: Int
}

struct TrendPoint: Identifiable, Hashable {
    var id: Date { day }
    let day: Date
    let available: Int64
    let total: Int64
}

enum StorageHistory {
    static let maximumRecords = 400
    static let minimumInterval: TimeInterval = 60 * 60

    /// Adds a reading, replacing the latest one if it was taken within `minimumInterval`,
    /// and trimming to `maximumRecords`.
    static func appending(_ snapshot: StorageSnapshot, to records: [StorageSnapshot], minimumInterval: TimeInterval = minimumInterval, limit: Int = maximumRecords) -> [StorageSnapshot] {
        var result = records.sorted { $0.date < $1.date }
        if let last = result.last, snapshot.date.timeIntervalSince(last.date) < minimumInterval, snapshot.date >= last.date {
            result[result.count - 1] = snapshot
        } else {
            result.append(snapshot)
            result.sort { $0.date < $1.date }
        }
        if result.count > limit { result.removeFirst(result.count - limit) }
        return result
    }

    /// One point per calendar day (the last reading of that day).
    static func dailySeries(_ records: [StorageSnapshot], calendar: Calendar = .current) -> [TrendPoint] {
        let byDay = Dictionary(grouping: records) { calendar.startOfDay(for: $0.date) }
        return byDay.compactMap { day, readings in
            guard let last = readings.max(by: { $0.date < $1.date }) else { return nil }
            return TrendPoint(day: day, available: last.available, total: last.totalCapacity)
        }
        .sorted { $0.day < $1.day }
    }

    /// Least-squares slope of available space, in bytes per week. Negative means space is being used up.
    /// Nil when there are fewer than two readings or they span less than a day.
    static func trendBytesPerWeek(_ records: [StorageSnapshot]) -> Double? {
        guard records.count >= 2,
              let first = records.map(\.date).min(),
              let last = records.map(\.date).max(),
              last.timeIntervalSince(first) >= 24 * 60 * 60 else { return nil }
        let xs = records.map { $0.date.timeIntervalSince(first) }
        let ys = records.map { Double($0.available) }
        let n = Double(records.count)
        let meanX = xs.reduce(0, +) / n
        let meanY = ys.reduce(0, +) / n
        var numerator = 0.0
        var denominator = 0.0
        for (x, y) in zip(xs, ys) {
            numerator += (x - meanX) * (y - meanY)
            denominator += (x - meanX) * (x - meanX)
        }
        guard denominator > 0 else { return nil }
        return numerator / denominator * 7 * 24 * 60 * 60
    }

    /// Days until available space falls below `target` at the current trend. Nil if not shrinking.
    static func daysUntilBelow(target: Int64, available: Int64, bytesPerWeek: Double?) -> Int? {
        guard let rate = bytesPerWeek, rate < 0 else { return nil }
        if available <= target { return 0 }
        let days = Double(available - target) * 7 / -rate
        return Int(days.rounded(.down))
    }

    static func summary(_ sessions: [CleanupSession]) -> RecoverySummary {
        var summary = RecoverySummary(sessions: sessions.count, itemsRemoved: 0, estimatedBytes: 0, measuredBytes: 0, sessionsWithMeasurement: 0)
        for session in sessions {
            summary.itemsRemoved += session.itemCount
            summary.estimatedBytes += session.estimated.bytes
            if let change = session.measuredChange {
                summary.sessionsWithMeasurement += 1
                summary.measuredBytes += max(0, change)
            }
        }
        return summary
    }
}
