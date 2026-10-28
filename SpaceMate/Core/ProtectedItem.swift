import Foundation

/// What SpaceMate knows about whether a protected item has a copy elsewhere.
enum BackupStatus: String, Codable, CaseIterable, Identifiable {
    case none
    /// The user says it is backed up. SpaceMate has not checked.
    case assumed
    /// SpaceMate exported a copy but could not read it back to check.
    case exportedUnverified
    /// SpaceMate exported a copy and its SHA-256 matched the original.
    case verified

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: return "No known backup"
        case .assumed: return "Backed up (your word, not verified)"
        case .exportedUnverified: return "Copy exported, not verified"
        case .verified: return "Verified copy (contents match)"
        }
    }

    var symbol: String {
        switch self {
        case .none: return "exclamationmark.shield"
        case .assumed: return "questionmark.circle"
        case .exportedUnverified: return "arrow.up.doc"
        case .verified: return "checkmark.seal.fill"
        }
    }

    /// Statuses the user may pick by hand. The app sets the export statuses itself.
    static let userSelectable: [BackupStatus] = [.none, .assumed]
}

enum ProtectedItemKind: String, Codable {
    case photoAsset
    case file
}

/// An item the user has asked SpaceMate to never suggest removing.
struct ProtectedItem: Codable, Identifiable, Hashable {
    /// Same identifier scheme as cleanup candidates: "photo:<localIdentifier>" or "file:<path>".
    let id: String
    var kind: ProtectedItemKind
    var displayName: String
    var location: String
    var bytes: Int64?
    var backupStatus: BackupStatus
    var protectedOn: Date
    var backupCheckedOn: Date?
}

enum ItemID {
    static func photo(_ localIdentifier: String) -> String { "photo:\(localIdentifier)" }
    static func file(_ url: URL) -> String { "file:\(url.resolvingSymlinksInPath().path)" }
}

enum Protection {
    /// Removes protected items from a list of candidate IDs.
    static func excluding(_ ids: [String], protected: Set<String>) -> [String] {
        ids.filter { !protected.contains($0) }
    }

    /// Inserts or replaces a protected item, keeping the date it was first protected.
    static func upsert(_ item: ProtectedItem, into items: [ProtectedItem]) -> [ProtectedItem] {
        var result = items
        if let index = result.firstIndex(where: { $0.id == item.id }) {
            var merged = item
            merged.protectedOn = result[index].protectedOn
            result[index] = merged
        } else {
            result.append(item)
        }
        return result
    }
}
