import Foundation

/// How a byte figure was obtained. Every size shown in the app carries one of these
/// so the user can tell a real measurement from a guess.
enum SizeConfidence: String, Codable, CaseIterable, Comparable {
    /// Derived from metadata such as resolution and duration. Can be off by a wide margin.
    case estimated
    /// Reported by the file system for a file the app inspected.
    case reported
    /// The app counted the bytes itself (for example by streaming the original from Photos).
    case measured

    private var rank: Int {
        switch self {
        case .estimated: return 0
        case .reported: return 1
        case .measured: return 2
        }
    }

    static func < (lhs: SizeConfidence, rhs: SizeConfidence) -> Bool { lhs.rank < rhs.rank }

    var label: String {
        switch self {
        case .estimated: return "Estimated"
        case .reported: return "Inspected"
        case .measured: return "Measured"
        }
    }

    var explanation: String {
        switch self {
        case .estimated:
            return "Calculated from resolution, duration or file type. Photos does not publish exact file sizes through a public API, so the real size may differ."
        case .reported:
            return "Size reported by iOS for a file SpaceMate inspected."
        case .measured:
            return "SpaceMate counted the bytes stored on this iPhone."
        }
    }
}

/// A byte count paired with how trustworthy it is.
struct ByteEstimate: Codable, Hashable {
    var bytes: Int64
    var confidence: SizeConfidence

    static let zero = ByteEstimate(bytes: 0, confidence: .measured)

    /// Adding figures keeps the weakest confidence: a total that includes a guess is a guess.
    static func + (lhs: ByteEstimate, rhs: ByteEstimate) -> ByteEstimate {
        ByteEstimate(bytes: lhs.bytes + rhs.bytes, confidence: min(lhs.confidence, rhs.confidence))
    }

    var formatted: String { ByteFormat.string(bytes) }
}

extension Sequence where Element == ByteEstimate {
    func total() -> ByteEstimate {
        reduce(nil as ByteEstimate?) { partial, next in partial.map { $0 + next } ?? next } ?? .zero
    }
}

enum ByteFormat {
    static func string(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    static let gigabyte: Int64 = 1_000_000_000
    static let megabyte: Int64 = 1_000_000
}
