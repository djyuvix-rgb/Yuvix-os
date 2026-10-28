import Photos
import XCTest
@testable import SpaceMate

final class StorageHistoryTests: XCTestCase {
    private func snap(_ seconds: TimeInterval, available: Int64) -> StorageSnapshot {
        StorageSnapshot(date: Date(timeIntervalSince1970: 1_700_000_000 + seconds), totalCapacity: 128 * ByteFormat.gigabyte,
                        availableForImportantUsage: available, availableRaw: nil)
    }

    func testAppendReplacesReadingsWithinInterval() {
        var records: [StorageSnapshot] = []
        records = StorageHistory.appending(snap(0, available: 10), to: records)
        records = StorageHistory.appending(snap(60, available: 11), to: records)
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].available, 11)
        records = StorageHistory.appending(snap(7200, available: 12), to: records)
        XCTAssertEqual(records.count, 2)
    }

    func testAppendTrimsToLimit() {
        var records: [StorageSnapshot] = []
        for i in 0..<10 { records = StorageHistory.appending(snap(Double(i) * 7200, available: Int64(i)), to: records, limit: 5) }
        XCTAssertEqual(records.count, 5)
        XCTAssertEqual(records.first?.available, 5, "oldest readings are dropped first")
    }

    func testDailySeriesUsesLastReadingPerDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let day = 86_400.0
        let records = [snap(0, available: 1), snap(3600, available: 2), snap(day, available: 3)]
        let series = StorageHistory.dailySeries(records, calendar: calendar)
        XCTAssertEqual(series.map(\.available), [2, 3])
    }

    func testTrendSlope() throws {
        let gb = ByteFormat.gigabyte
        let records = (0..<8).map { snap(Double($0) * 86_400, available: (50 - Int64($0)) * gb) } // -1 GB/day
        let slope = try XCTUnwrap(StorageHistory.trendBytesPerWeek(records))
        XCTAssertEqual(slope, -7 * Double(gb), accuracy: Double(gb) * 0.01)
        XCTAssertEqual(StorageHistory.daysUntilBelow(target: 10 * gb, available: 43 * gb, bytesPerWeek: -7 * Double(gb)), 33)
        XCTAssertNil(StorageHistory.daysUntilBelow(target: 10 * gb, available: 43 * gb, bytesPerWeek: 5))
        XCTAssertEqual(StorageHistory.daysUntilBelow(target: 10 * gb, available: 5 * gb, bytesPerWeek: slope), 0)
    }

    func testTrendNeedsEnoughData() {
        XCTAssertNil(StorageHistory.trendBytesPerWeek([]))
        XCTAssertNil(StorageHistory.trendBytesPerWeek([snap(0, available: 1)]))
        XCTAssertNil(StorageHistory.trendBytesPerWeek([snap(0, available: 1), snap(3600, available: 2)]), "less than a day of data")
    }

    func testRecoverySummarySeparatesEstimatedAndMeasured() {
        let sessions = [
            CleanupSession(date: Date(), source: .files, itemCount: 2, estimated: ByteEstimate(bytes: 500, confidence: .reported),
                           before: snap(0, available: 1000), after: snap(10, available: 1450)),
            CleanupSession(date: Date(), source: .photos, itemCount: 3, estimated: ByteEstimate(bytes: 900, confidence: .estimated),
                           before: snap(20, available: 1450), after: snap(30, available: 1400)), // other activity used space
            CleanupSession(date: Date(), source: .photos, itemCount: 1, estimated: ByteEstimate(bytes: 100, confidence: .estimated),
                           before: nil, after: nil),
        ]
        let summary = StorageHistory.summary(sessions)
        XCTAssertEqual(summary.sessions, 3)
        XCTAssertEqual(summary.itemsRemoved, 6)
        XCTAssertEqual(summary.estimatedBytes, 1500)
        XCTAssertEqual(summary.measuredBytes, 450, "negative measured changes are not counted as recovery")
        XCTAssertEqual(summary.sessionsWithMeasurement, 2)
        XCTAssertNil(sessions[2].measuredChange, "no measurement means no claim")
    }

    func testReminderComponents() {
        XCTAssertNil(ReminderFrequency.off.triggerComponents(hour: 9))
        let weekly = ReminderFrequency.weekly.triggerComponents(hour: 9, weekday: 1)
        XCTAssertEqual(weekly?.weekday, 1)
        XCTAssertEqual(weekly?.hour, 9)
        XCTAssertNil(weekly?.day)
        let monthly = ReminderFrequency.monthly.triggerComponents(hour: 18)
        XCTAssertEqual(monthly?.day, 1)
        XCTAssertNil(monthly?.weekday)
    }
}

final class PersistenceTests: XCTestCase {
    var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testRoundTrip() throws {
        let store = PersistenceStore(directory: directory)
        var data = AppData()
        data.settings.freeSpaceTarget = 42
        data.protectedItems = [ProtectedItem(id: "file:/a", kind: .file, displayName: "a", location: "/", bytes: 1, backupStatus: .verified, protectedOn: Date())]
        data.snapshots = [StorageSnapshot(date: Date(), totalCapacity: 10, availableForImportantUsage: 5, availableRaw: 4)]
        data.sessions = [CleanupSession(date: Date(), source: .files, itemCount: 1, estimated: .zero)]
        try store.save(data)
        XCTAssertEqual(store.load(), data)
    }

    func testMissingOrCorruptFileLoadsEmpty() throws {
        let store = PersistenceStore(directory: directory)
        XCTAssertEqual(store.load(), .empty)
        try FileManager.default.createDirectory(at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: store.fileURL)
        XCTAssertEqual(store.load(), .empty)
    }

    func testFailedWriteThrows() throws {
        // Put a plain file where the store's folder should be, so the write must fail.
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data().write(to: directory.appendingPathComponent("SpaceMate"))
        let store = PersistenceStore(directory: directory)
        XCTAssertThrowsError(try store.save(AppData()))
    }

    func testEraseRemovesData() throws {
        let store = PersistenceStore(directory: directory)
        try store.save(AppData())
        try store.erase()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
        XCTAssertNoThrow(try store.erase(), "erasing twice is harmless")
    }
}

final class FileScannerTests: XCTestCase {
    var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("Scan-\(UUID().uuidString)")
        let downloads = root.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let payload = Data(repeating: 7, count: 4096)
        try payload.write(to: root.appendingPathComponent("Mix.wav"))
        try payload.write(to: downloads.appendingPathComponent("Mix (1).wav"))
        try Data(repeating: 9, count: 4096).write(to: root.appendingPathComponent("Other.wav"))  // same size, different bytes
        try Data(repeating: 1, count: 10).write(to: downloads.appendingPathComponent("setup.zip"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testScanFindsFilesWithMetadata() throws {
        let result = try FileScanner().scan(roots: [root])
        XCTAssertEqual(result.files.count, 4)
        XCTAssertTrue(result.issues.isEmpty)
        let zip = try XCTUnwrap(result.files.first { $0.name == "setup.zip" })
        XCTAssertTrue(zip.isInDownloadsFolder)
        XCTAssertEqual(zip.category, .archive)
        XCTAssertEqual(zip.size, 10)
        XCTAssertTrue(zip.displayPath.hasPrefix(root.lastPathComponent + "/Downloads"))
        let mix = try XCTUnwrap(result.files.first { $0.name == "Mix.wav" })
        XCTAssertFalse(mix.isInDownloadsFolder)
        XCTAssertFalse(mix.valuableReasons.isEmpty)
    }

    func testSingleFileRoot() throws {
        let result = try FileScanner().scan(roots: [root.appendingPathComponent("Mix.wav")])
        XCTAssertEqual(result.files.map(\.name), ["Mix.wav"])
    }

    func testEndToEndDuplicateDetection() throws {
        var files = try FileScanner().scan(roots: [root]).files
        let candidates = FileScanner.hashCandidates(files)
        XCTAssertEqual(Set(candidates.map(\.name)), ["Mix.wav", "Mix (1).wav", "Other.wav"], "zip has a unique size and is never hashed")
        for index in files.indices where candidates.contains(where: { $0.id == files[index].id }) {
            files[index].sha256 = try FileHasher.sha256(of: files[index].url)
        }
        let groups = DuplicateFinder.exactGroups(files, id: \.id, hash: \.sha256, size: \.localBytes)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].memberIDs.compactMap { id in files.first { $0.id == id }?.name }), ["Mix.wav", "Mix (1).wav"])
    }

    func testDeleteReportsRealOutcome() throws {
        let url = root.appendingPathComponent("Other.wav")
        XCTAssertEqual(FileOperations().delete(url), .deleted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        if case .deleted = FileOperations().delete(url) {
            XCTFail("deleting a missing file must not be reported as success")
        }
    }

    func testVerifyCopy() throws {
        let original = root.appendingPathComponent("Mix.wav")
        let copy = root.appendingPathComponent("copy.wav")
        try FileManager.default.copyItem(at: original, to: copy)
        XCTAssertTrue(FileOperations.verifyCopy(original: original, copy: copy))
        XCTAssertFalse(FileOperations.verifyCopy(original: original, copy: root.appendingPathComponent("Other.wav")))
        XCTAssertFalse(FileOperations.verifyCopy(original: original, copy: root.appendingPathComponent("missing.wav")))
    }

    func testMissingRootIsReportedNotCrashed() throws {
        let result = try FileScanner().scan(roots: [root.appendingPathComponent("does-not-exist")])
        XCTAssertTrue(result.files.isEmpty)
        XCTAssertFalse(result.issues.isEmpty)
    }
}

final class PermissionStateTests: XCTestCase {
    func testAccessStates() {
        XCTAssertFalse(MediaAccess.denied.canAnalyze)
        XCTAssertFalse(MediaAccess.notDetermined.canAnalyze)
        XCTAssertFalse(MediaAccess.restricted.canAnalyze)
        XCTAssertTrue(MediaAccess.limited.canAnalyze)
        XCTAssertTrue(MediaAccess.full.canAnalyze)
        XCTAssertTrue(MediaAccess.denied.message.contains("Settings"))
        XCTAssertTrue(MediaAccess.limited.message.contains("selected"))
    }

    func testPhotoKitStatusMapping() {
        XCTAssertEqual(PhotoLibraryService.map(.denied), .denied)
        XCTAssertEqual(PhotoLibraryService.map(.limited), .limited)
        XCTAssertEqual(PhotoLibraryService.map(.authorized), .full)
        XCTAssertEqual(PhotoLibraryService.map(.restricted), .restricted)
        XCTAssertEqual(PhotoLibraryService.map(.notDetermined), .notDetermined)
    }

    func testGuidesAreComplete() {
        for guide in SettingsGuide.all {
            XCTAssertFalse(guide.steps.isEmpty, guide.id)
            XCTAssertFalse(guide.whatYouMayLose.isEmpty, guide.id)
            XCTAssertEqual(guide.steps.first, "Settings", guide.id)
        }
    }
}
