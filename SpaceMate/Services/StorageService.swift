import Foundation

/// Reads device capacity through the public `URLResourceValues` volume keys.
/// iOS gives apps the volume totals only, not a per-app or per-category breakdown.
enum StorageService {
    enum StorageError: LocalizedError {
        case unavailable

        var errorDescription: String? { "iOS did not report storage capacity." }
    }

    static func currentSnapshot(date: Date = Date()) throws -> StorageSnapshot {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        let values = try url.resourceValues(forKeys: [
            .volumeTotalCapacityKey,
            .volumeAvailableCapacityKey,
            .volumeAvailableCapacityForImportantUsageKey,
        ])
        guard let total = values.volumeTotalCapacity, total > 0 else { throw StorageError.unavailable }
        return StorageSnapshot(
            date: date,
            totalCapacity: Int64(total),
            availableForImportantUsage: values.volumeAvailableCapacityForImportantUsage,
            availableRaw: values.volumeAvailableCapacity.map(Int64.init)
        )
    }
}
