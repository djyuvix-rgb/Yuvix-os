import Foundation

/// Estimates photo-library item sizes from public metadata. PhotoKit has no documented API
/// for an asset's file size, so every figure from here is labelled "Estimated".
/// The app can replace an estimate with a measurement by streaming the original.
enum MediaSizeEstimator {
    /// Approximate HEVC bitrates of iPhone camera video, in bits per pixel per second,
    /// based on Apple's published per-minute sizes (about 60 MB/min for 1080p30 and 170 MB/min for 4K30).
    static let bitsPerPixelSecondHD: Double = 3.9
    static let bitsPerPixelSecond4K: Double = 2.7
    /// Screen recordings are mostly static, so they compress better than camera video.
    static let screenRecordingFactor: Double = 0.5

    static func videoBytes(pixelWidth: Int, pixelHeight: Int, durationSeconds: Double, isScreenRecording: Bool) -> Int64 {
        let pixels = Double(max(0, pixelWidth) * max(0, pixelHeight))
        guard pixels > 0, durationSeconds > 0 else { return 0 }
        let rate: Double
        if pixels <= 2_100_000 {
            rate = bitsPerPixelSecondHD
        } else if pixels >= 8_000_000 {
            rate = bitsPerPixelSecond4K
        } else {
            let t = (pixels - 2_100_000) / (8_000_000 - 2_100_000)
            rate = bitsPerPixelSecondHD + (bitsPerPixelSecond4K - bitsPerPixelSecondHD) * t
        }
        let factor = isScreenRecording ? screenRecordingFactor : 1
        return Int64(pixels * rate * factor * durationSeconds / 8)
    }

    /// HEIC photos average roughly 0.2 bytes per pixel; screenshots (PNG) closer to 0.35.
    static func photoBytes(pixelWidth: Int, pixelHeight: Int, isScreenshot: Bool, isLivePhoto: Bool) -> Int64 {
        let pixels = Double(max(0, pixelWidth) * max(0, pixelHeight))
        let still = pixels * (isScreenshot ? 0.35 : 0.2)
        // A Live Photo carries a short video (about 3 seconds at 1080p-class resolution).
        let motion: Double = isLivePhoto ? 2_500_000 : 0
        return Int64(still + motion)
    }

    static let methodDescriptionVideo = "Estimated from resolution × duration using typical iPhone HEVC bitrates. Tap “Measure exact size” to count the real bytes stored on this iPhone."
    static let methodDescriptionPhoto = "Estimated from pixel count using typical HEIC/PNG compression."
}

/// PhotoKit labels screenshots but has no public flag for screen recordings, so SpaceMate
/// recognises them by shape: iOS records at the screen's native size (1170 × 2532 on iPhone 13),
/// an aspect ratio of about 2.16 that iPhone camera video (16:9 or 4:3) never uses.
/// The UI always calls these "likely" screen recordings.
enum ScreenRecordingHeuristic {
    static let aspectRange: ClosedRange<Double> = 1.95...2.4

    static func isLikely(pixelWidth: Int, pixelHeight: Int) -> Bool {
        let long = max(pixelWidth, pixelHeight)
        let short = min(pixelWidth, pixelHeight)
        guard short > 0 else { return false }
        return aspectRange.contains(Double(long) / Double(short))
    }
}
