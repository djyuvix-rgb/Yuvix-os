import Foundation

/// A set of items whose contents hash identically.
struct DuplicateGroup: Identifiable, Hashable {
    /// The shared content hash.
    let id: String
    let memberIDs: [String]
    let bytesPerCopy: Int64

    /// Space freed by keeping exactly one copy. The user chooses which.
    var reclaimableBytes: Int64 { bytesPerCopy * Int64(max(0, memberIDs.count - 1)) }
}

enum DuplicateFinder {
    /// Items that share a non-zero size with at least one other item. Only these need hashing:
    /// files of different sizes can't be identical.
    static func sizeCollisions<T>(_ items: [T], size: (T) -> Int64) -> [T] {
        let bySize = Dictionary(grouping: items.filter { size($0) > 0 }, by: size)
        return bySize.values.filter { $0.count > 1 }.flatMap { $0 }
    }

    /// Groups items by content hash, keeping only hashes shared by two or more items.
    /// Items without a hash (unreadable, not downloaded) are never grouped.
    static func exactGroups<T>(
        _ items: [T],
        id: (T) -> String,
        hash: (T) -> String?,
        size: (T) -> Int64
    ) -> [DuplicateGroup] {
        var byHash: [String: [T]] = [:]
        for item in items {
            guard let h = hash(item) else { continue }
            byHash[h, default: []].append(item)
        }
        return byHash.compactMap { key, members -> DuplicateGroup? in
            guard members.count > 1 else { return nil }
            return DuplicateGroup(id: key, memberIDs: members.map(id).sorted(), bytesPerCopy: size(members[0]))
        }
        .sorted { $0.reclaimableBytes > $1.reclaimableBytes }
    }

    /// Bytes freed by keeping one item of a group and removing the rest, without
    /// assuming which one is kept: we assume the largest stays, which gives the smallest saving.
    static func conservativeSavings(memberSizes: [Int64]) -> Int64 {
        guard memberSizes.count > 1, let largest = memberSizes.max() else { return 0 }
        return memberSizes.reduce(0, +) - largest
    }
}
