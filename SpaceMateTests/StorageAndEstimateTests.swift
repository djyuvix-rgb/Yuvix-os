import XCTest
@testable import SpaceMate

final class StorageMathTests: XCTestCase {
    func testUsedAndFraction() {
        XCTAssertEqual(StorageMath.usedBytes(total: 128_000, available: 28_000), 100_000)
        XCTAssertEqual(StorageMath.usedFraction(total: 200, available: 50), 0.75, accuracy: 0.0001)
    }

    func testDegenerateInputsAreClamped() {
        XCTAssertEqual(StorageMath.usedBytes(total: 0, available: 10), 0)
        XCTAssertEqual(StorageMath.usedFraction(total: 0, available: 0), 0)
        XCTAssertEqual(StorageMath.usedBytes(total: 100, available: 150), 0, "available larger than total must not go negative")
        XCTAssertEqual(StorageMath.usedBytes(total: 100, available: -5), 100)
    }

    func testTargetCalculations() {
        let gb = ByteFormat.gigabyte
        XCTAssertEqual(StorageMath.bytesNeeded(toReach: 10 * gb, available: 4 * gb), 6 * gb)
        XCTAssertEqual(StorageMath.bytesNeeded(toReach: 10 * gb, available: 12 * gb), 0)
        XCTAssertTrue(StorageMath.isBelowTarget(available: 4 * gb, target: 10 * gb))
        XCTAssertFalse(StorageMath.isBelowTarget(available: 10 * gb, target: 10 * gb))
    }

    func testSnapshotPrefersImportantUsageAndComputesPurgeable() {
        let snapshot = StorageSnapshot(date: Date(), totalCapacity: 1000, availableForImportantUsage: 300, availableRaw: 200)
        XCTAssertEqual(snapshot.available, 300)
        XCTAssertEqual(snapshot.used, 700)
        XCTAssertEqual(snapshot.purgeableEstimate, 100)

        let rawOnly = StorageSnapshot(date: Date(), totalCapacity: 1000, availableForImportantUsage: nil, availableRaw: 200)
        XCTAssertEqual(rawOnly.available, 200)
        XCTAssertNil(rawOnly.purgeableEstimate)
    }

    func testMeasuredChange() {
        let before = StorageSnapshot(date: Date(), totalCapacity: 1000, availableForImportantUsage: 300, availableRaw: nil)
        let after = StorageSnapshot(date: Date(), totalCapacity: 1000, availableForImportantUsage: 450, availableRaw: nil)
        XCTAssertEqual(StorageMath.measuredChange(before: before, after: after), 150)
        XCTAssertEqual(StorageMath.measuredChange(before: after, after: before), -150)
    }

    func testRealDeviceSnapshotIsConsistent() throws {
        let snapshot = try StorageService.currentSnapshot()
        XCTAssertGreaterThan(snapshot.totalCapacity, 0)
        XCTAssertGreaterThanOrEqual(snapshot.available, 0)
        XCTAssertLessThanOrEqual(snapshot.used, snapshot.totalCapacity)
    }
}

final class ByteEstimateTests: XCTestCase {
    func testSumKeepsWeakestConfidence() {
        let a = ByteEstimate(bytes: 100, confidence: .measured)
        let b = ByteEstimate(bytes: 50, confidence: .estimated)
        let c = ByteEstimate(bytes: 25, confidence: .reported)
        XCTAssertEqual((a + c).confidence, .reported)
        XCTAssertEqual([a, b, c].total(), ByteEstimate(bytes: 175, confidence: .estimated))
    }

    func testEmptyTotalIsZero() {
        XCTAssertEqual([ByteEstimate]().total().bytes, 0)
    }
}

final class MediaSizeEstimatorTests: XCTestCase {
    func testHDVideoMatchesPublishedRate() {
        // Apple: about 60 MB per minute for 1080p at 30 fps (HEVC).
        let bytes = MediaSizeEstimator.videoBytes(pixelWidth: 1920, pixelHeight: 1080, durationSeconds: 60, isScreenRecording: false)
        XCTAssertEqual(Double(bytes), 60_000_000, accuracy: 6_000_000)
    }

    func test4KVideoMatchesPublishedRate() {
        // Apple: about 170 MB per minute for 4K at 30 fps (HEVC).
        let bytes = MediaSizeEstimator.videoBytes(pixelWidth: 3840, pixelHeight: 2160, durationSeconds: 60, isScreenRecording: false)
        XCTAssertEqual(Double(bytes), 170_000_000, accuracy: 17_000_000)
    }

    func testScreenRecordingIsDiscounted() {
        let camera = MediaSizeEstimator.videoBytes(pixelWidth: 1170, pixelHeight: 2532, durationSeconds: 120, isScreenRecording: false)
        let screen = MediaSizeEstimator.videoBytes(pixelWidth: 1170, pixelHeight: 2532, durationSeconds: 120, isScreenRecording: true)
        XCTAssertEqual(Double(screen), Double(camera) * MediaSizeEstimator.screenRecordingFactor, accuracy: 2)
    }

    func testDegenerateMediaIsZero() {
        XCTAssertEqual(MediaSizeEstimator.videoBytes(pixelWidth: 1920, pixelHeight: 1080, durationSeconds: 0, isScreenRecording: false), 0)
        XCTAssertEqual(MediaSizeEstimator.videoBytes(pixelWidth: 0, pixelHeight: 1080, durationSeconds: 10, isScreenRecording: false), 0)
        XCTAssertEqual(MediaSizeEstimator.photoBytes(pixelWidth: 0, pixelHeight: 0, isScreenshot: false, isLivePhoto: false), 0)
    }

    func testLivePhotoAddsMotionComponent() {
        let still = MediaSizeEstimator.photoBytes(pixelWidth: 4032, pixelHeight: 3024, isScreenshot: false, isLivePhoto: false)
        let live = MediaSizeEstimator.photoBytes(pixelWidth: 4032, pixelHeight: 3024, isScreenshot: false, isLivePhoto: true)
        XCTAssertGreaterThan(live, still)
        XCTAssertEqual(Double(still), 2_440_000, accuracy: 100_000)
    }
}

final class ScreenRecordingHeuristicTests: XCTestCase {
    func testScreenShapedVideosMatchInEitherOrientation() {
        XCTAssertTrue(ScreenRecordingHeuristic.isLikely(pixelWidth: 1170, pixelHeight: 2532)) // iPhone 13
        XCTAssertTrue(ScreenRecordingHeuristic.isLikely(pixelWidth: 2532, pixelHeight: 1170))
        XCTAssertTrue(ScreenRecordingHeuristic.isLikely(pixelWidth: 886, pixelHeight: 1920))  // scaled recording
    }

    func testCameraVideoDoesNotMatch() {
        XCTAssertFalse(ScreenRecordingHeuristic.isLikely(pixelWidth: 1920, pixelHeight: 1080))
        XCTAssertFalse(ScreenRecordingHeuristic.isLikely(pixelWidth: 2160, pixelHeight: 3840))
        XCTAssertFalse(ScreenRecordingHeuristic.isLikely(pixelWidth: 1440, pixelHeight: 1080))
        XCTAssertFalse(ScreenRecordingHeuristic.isLikely(pixelWidth: 0, pixelHeight: 0))
    }
}
