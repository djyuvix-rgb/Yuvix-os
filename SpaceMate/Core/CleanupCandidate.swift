import Foundation

enum CandidateKind: String, Codable, CaseIterable, Identifiable {
    case screenRecordings
    case duplicateFiles
    case largeDownloads
    case screenshots
    case largeVideos
    case similarPhotos
    case redundantExports
    case largeFiles

    var id: String { rawValue }

    var title: String {
        switch self {
        case .screenRecordings: return "Long screen recordings"
        case .duplicateFiles: return "Identical duplicate files"
        case .largeDownloads: return "Large downloaded files"
        case .screenshots: return "Screenshots"
        case .largeVideos: return "Large videos"
        case .similarPhotos: return "Similar photos"
        case .redundantExports: return "Possible repeated exports"
        case .largeFiles: return "Large files you've scanned"
        }
    }

    var symbol: String {
        switch self {
        case .screenRecordings: return "record.circle"
        case .duplicateFiles: return "doc.on.doc"
        case .largeDownloads: return "arrow.down.circle"
        case .screenshots: return "camera.viewfinder"
        case .largeVideos: return "film.stack"
        case .similarPhotos: return "square.on.square"
        case .redundantExports: return "square.stack.3d.up"
        case .largeFiles: return "externaldrive"
        }
    }

    var isPhotoLibrary: Bool {
        switch self {
        case .screenRecordings, .screenshots, .largeVideos, .similarPhotos: return true
        default: return false
        }
    }

    var risk: RiskLevel {
        switch self {
        case .screenRecordings, .duplicateFiles, .screenshots, .largeDownloads: return .low
        case .largeVideos, .similarPhotos, .redundantExports, .largeFiles: return .medium
        }
    }

    var effort: Effort {
        switch self {
        case .duplicateFiles, .screenRecordings, .largeDownloads: return .quick
        case .screenshots, .largeVideos, .largeFiles: return .moderate
        case .similarPhotos, .redundantExports: return .involved
        }
    }

    var reversibility: Reversibility { isPhotoLibrary ? .recentlyDeleted : .permanent }

    /// For groups of copies one member is always kept, so only the others count as savings.
    var isGroupOfCopies: Bool {
        switch self {
        case .duplicateFiles, .similarPhotos, .redundantExports: return true
        default: return false
        }
    }

    var why: String {
        switch self {
        case .screenRecordings: return "Screen recordings are often captured for a moment and forgotten, yet they're stored at full screen resolution."
        case .duplicateFiles: return "These files have byte-for-byte identical contents (matching SHA-256 hashes). Keeping one copy loses nothing."
        case .largeDownloads: return "Large files in a Downloads folder are often installers, archives or one-off downloads you no longer need."
        case .screenshots: return "Screenshots pile up quickly and are rarely needed long-term."
        case .largeVideos: return "Videos are usually the single biggest use of photo-library space."
        case .similarPhotos: return "Bursts and near-identical shots look alike. Keeping only your favourite of each set saves space. SpaceMate never decides which one to keep."
        case .redundantExports: return "Files in the same folder share a name apart from suffixes like “(1)”, “copy”, “v2” or “final”. They may be repeated exports, but they could also be different versions you need."
        case .largeFiles: return "The largest files in the folders you scanned."
        }
    }

    var howTo: String {
        switch self {
        case .screenRecordings, .screenshots, .largeVideos:
            return "Open the list, preview items, select the ones you don't need, then review and confirm deletion."
        case .similarPhotos:
            return "Open each group, compare the photos and select only the ones you want to remove."
        case .duplicateFiles:
            return "Open each duplicate group and choose which copies to delete. Keep at least one."
        case .redundantExports:
            return "Compare the versions (preview or play them) and delete only the ones you're sure about. Export a copy first if unsure."
        case .largeDownloads, .largeFiles:
            return "Review each file's details and preview. Export or share anything you want to keep elsewhere before deleting."
        }
    }

    var estimateMethod: String {
        switch self {
        case .screenRecordings, .largeVideos:
            return MediaSizeEstimator.methodDescriptionVideo
        case .screenshots:
            return MediaSizeEstimator.methodDescriptionPhoto
        case .similarPhotos:
            return MediaSizeEstimator.methodDescriptionPhoto + " Assumes you keep the largest photo in each group."
        case .duplicateFiles:
            return "File sizes reported by iOS. Counts every copy except one per group."
        case .redundantExports:
            return "File sizes reported by iOS. Assumes you keep the largest file in each group."
        case .largeDownloads, .largeFiles:
            return "File sizes reported by iOS for files you gave SpaceMate access to."
        }
    }

    var cloudNote: String? {
        switch self {
        case .screenRecordings, .screenshots, .largeVideos, .similarPhotos:
            return "If iCloud Photos is on, deleting here also deletes from iCloud and your other devices. With “Optimize iPhone Storage” on, this iPhone may only hold a small version, so it frees less space here than the estimate."
        default:
            return "If these files are in iCloud Drive or another cloud folder, deleting removes them for every device using that folder."
        }
    }
}

enum RiskLevel: Int, Codable, Comparable, CaseIterable {
    case low, medium, high
    static func < (lhs: RiskLevel, rhs: RiskLevel) -> Bool { lhs.rawValue < rhs.rawValue }

    var label: String {
        switch self {
        case .low: return "Low risk"
        case .medium: return "Review carefully"
        case .high: return "High risk"
        }
    }
}

enum Effort: Int, Codable, Comparable {
    case quick, moderate, involved
    static func < (lhs: Effort, rhs: Effort) -> Bool { lhs.rawValue < rhs.rawValue }
}

enum Reversibility: String, Codable {
    /// Photos moves deleted items to Recently Deleted for about 30 days.
    case recentlyDeleted
    /// File deletion in a third-party app can't be undone.
    case permanent
    case notApplicable

    var label: String {
        switch self {
        case .recentlyDeleted: return "Reversible for about 30 days (Photos → Recently Deleted). Space is only freed once items leave Recently Deleted."
        case .permanent: return "Permanent. Files deleted by SpaceMate can't be restored unless you have another copy."
        case .notApplicable: return "Nothing is deleted by this step."
        }
    }
}

/// One item SpaceMate could suggest removing, e.g. a single video, or a group of copies.
struct CleanupCandidate: Identifiable, Hashable {
    struct Member: Hashable {
        let id: String
        let bytes: Int64
    }

    let id: String
    let kind: CandidateKind
    let members: [Member]
    let confidence: SizeConfidence
    var hasValuableSigns: Bool = false

    var totalBytes: Int64 { members.reduce(0) { $0 + $1.bytes } }
}
