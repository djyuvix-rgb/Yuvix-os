import CryptoKit
import Foundation

/// Streams files through SHA-256 so large videos never have to fit in memory.
enum FileHasher {
    static let chunkSize = 1 << 20

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            try Task.checkCancellation()
            let chunk = try autoreleasepool { try handle.read(upToCount: chunkSize) }
            guard let chunk, !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hex(hasher.finalize())
    }

    static func sha256(of data: Data) -> String {
        hex(SHA256.hash(data: data))
    }

    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Incremental SHA-256 for data that arrives in chunks (for example from `PHAssetResourceManager`).
struct StreamingSHA256 {
    private var hasher = SHA256()
    private(set) var byteCount: Int64 = 0

    mutating func update(_ data: Data) {
        hasher.update(data: data)
        byteCount += Int64(data.count)
    }

    func finalize() -> String { FileHasher.hex(hasher.finalize()) }
}
