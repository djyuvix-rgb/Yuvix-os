import Foundation

/// One reading of the device's file-system capacity, taken from public `URLResourceValues`.
struct StorageSnapshot: Codable, Hashable, Identifiable {
    var id: Date { date }
    var date: Date
    /// `volumeTotalCapacity`.
    var totalCapacity: Int64
    /// `volumeAvailableCapacityForImportantUsage`: free space plus space iOS can purge on demand.
    var availableForImportantUsage: Int64?
    /// `volumeAvailableCapacity`: space that is free right now.
    var availableRaw: Int64?

    /// The figure that best matches what iOS Settings reports as available.
    var available: Int64 { availableForImportantUsage ?? availableRaw ?? 0 }
    var used: Int64 { StorageMath.usedBytes(total: totalCapacity, available: available) }
    var usedFraction: Double { StorageMath.usedFraction(total: totalCapacity, available: available) }

    /// Space iOS could reclaim on its own (caches, offloadable content) if it needed to.
    var purgeableEstimate: Int64? {
        guard let important = availableForImportantUsage, let raw = availableRaw else { return nil }
        return max(0, important - raw)
    }
}

enum StorageMath {
    static func usedBytes(total: Int64, available: Int64) -> Int64 {
        guard total > 0 else { return 0 }
        return max(0, total - min(max(available, 0), total))
    }

    static func usedFraction(total: Int64, available: Int64) -> Double {
        guard total > 0 else { return 0 }
        return Double(usedBytes(total: total, available: available)) / Double(total)
    }

    /// How much must be freed to reach the user's free-space target. Zero if already met.
    static func bytesNeeded(toReach target: Int64, available: Int64) -> Int64 {
        max(0, target - available)
    }

    static func isBelowTarget(available: Int64, target: Int64) -> Bool {
        available < target
    }

    /// The change in available space between two readings. Positive means space was freed.
    /// Other activity on the phone between the readings also affects this number.
    static func measuredChange(before: StorageSnapshot, after: StorageSnapshot) -> Int64 {
        after.available - before.available
    }
}
