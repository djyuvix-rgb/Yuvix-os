import Foundation

/// A 64-bit difference hash ("dHash") of an image. Visually similar images have hashes
/// a small Hamming distance apart. A match means "looks alike", never "is identical".
struct PerceptualHash: Hashable, Codable {
    let value: UInt64

    static let width = 9
    static let height = 8

    /// Builds a hash from a 9×8 grayscale thumbnail, row-major.
    init?(grayscale pixels: [UInt8]) {
        guard pixels.count == Self.width * Self.height else { return nil }
        var bits: UInt64 = 0
        var index: UInt64 = 0
        for row in 0..<Self.height {
            for col in 0..<(Self.width - 1) {
                let left = pixels[row * Self.width + col]
                let right = pixels[row * Self.width + col + 1]
                if left > right { bits |= (1 << index) }
                index += 1
            }
        }
        value = bits
    }

    init(value: UInt64) { self.value = value }

    func distance(to other: PerceptualHash) -> Int {
        (value ^ other.value).nonzeroBitCount
    }
}

/// An image that has been hashed, ready for similarity grouping.
struct HashedImage: Hashable {
    let id: String
    let hash: PerceptualHash
    let date: Date?
}

enum SimilarityGrouper {
    /// Hashes this close are treated as "similar". Kept strict to limit false positives.
    static let defaultThreshold = 5
    /// Above this many images, compare each image only with its neighbours in time
    /// plus exact hash matches, to keep analysis fast on large libraries.
    static let fullComparisonLimit = 4000
    static let neighbourWindow = 120

    /// Returns groups of two or more image IDs that look alike, largest groups first.
    static func groups(_ images: [HashedImage], threshold: Int = defaultThreshold) -> [[String]] {
        guard images.count > 1 else { return [] }
        let sorted = images.sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }
        var sets = UnionFind(count: sorted.count)

        if sorted.count <= fullComparisonLimit {
            for i in 0..<sorted.count {
                for j in (i + 1)..<sorted.count where sorted[i].hash.distance(to: sorted[j].hash) <= threshold {
                    sets.union(i, j)
                }
            }
        } else {
            for i in 0..<sorted.count {
                let upper = min(sorted.count, i + 1 + neighbourWindow)
                for j in (i + 1)..<upper where sorted[i].hash.distance(to: sorted[j].hash) <= threshold {
                    sets.union(i, j)
                }
            }
            let byHash = Dictionary(grouping: sorted.indices, by: { sorted[$0].hash })
            for indices in byHash.values where indices.count > 1 {
                for index in indices.dropFirst() { sets.union(indices[0], index) }
            }
        }

        var clusters: [Int: [String]] = [:]
        for i in sorted.indices { clusters[sets.find(i), default: []].append(sorted[i].id) }
        return clusters.values.filter { $0.count > 1 }.sorted { $0.count > $1.count }
    }
}

struct UnionFind {
    private var parent: [Int]
    private var rank: [Int]

    init(count: Int) {
        parent = Array(0..<count)
        rank = Array(repeating: 0, count: count)
    }

    mutating func find(_ x: Int) -> Int {
        var root = x
        while parent[root] != root { root = parent[root] }
        var node = x
        while parent[node] != root {
            let next = parent[node]
            parent[node] = root
            node = next
        }
        return root
    }

    mutating func union(_ a: Int, _ b: Int) {
        let ra = find(a), rb = find(b)
        guard ra != rb else { return }
        if rank[ra] < rank[rb] {
            parent[ra] = rb
        } else if rank[ra] > rank[rb] {
            parent[rb] = ra
        } else {
            parent[rb] = ra
            rank[ra] += 1
        }
    }
}
