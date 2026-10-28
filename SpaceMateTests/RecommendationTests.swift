import XCTest
@testable import SpaceMate

final class RecommendationEngineTests: XCTestCase {
    private let mb = ByteFormat.megabyte

    private func single(_ id: String, _ kind: CandidateKind, _ bytes: Int64, _ confidence: SizeConfidence = .estimated) -> CleanupCandidate {
        CleanupCandidate(id: "\(kind.rawValue):\(id)", kind: kind, members: [.init(id: id, bytes: bytes)], confidence: confidence)
    }

    func testEmptyLibraryProducesOnlyGuidesWithoutEstimates() {
        let recs = RecommendationEngine.recommendations(candidates: [], protectedIDs: [])
        XCTAssertFalse(recs.isEmpty)
        XCTAssertTrue(recs.allSatisfy { $0.estimate == nil }, "never invent sizes for things the app can't measure")
        XCTAssertEqual(RecommendationEngine.totalEstimate(recs).bytes, 0)
        XCTAssertTrue(RecommendationEngine.recommendations(candidates: [], protectedIDs: [], includeGuides: false).isEmpty)
    }

    func testAggregatesByKindAndTiers() {
        let candidates = [
            single("v1", .largeVideos, 900 * mb),
            single("v2", .largeVideos, 600 * mb),
            single("s1", .screenRecordings, 200 * mb),
            single("f1", .largeDownloads, 50 * mb, .reported),
        ]
        let recs = RecommendationEngine.recommendations(candidates: candidates, protectedIDs: [], includeGuides: false)
        let videos = try? XCTUnwrap(recs.first { $0.id == CandidateKind.largeVideos.rawValue })
        XCTAssertEqual(videos?.estimate?.bytes, 1500 * mb)
        XCTAssertEqual(videos?.itemCount, 2)
        XCTAssertEqual(videos?.tier, .highImpact)
        XCTAssertEqual(recs.first { $0.id == CandidateKind.screenRecordings.rawValue }?.tier, .quickWin)
        XCTAssertEqual(recs.first?.tier, .quickWin, "quick wins come first")
    }

    func testQuickWinsRankedBySpaceWithinTier() {
        let candidates = [single("small", .largeDownloads, 60 * mb, .reported), single("big", .screenRecordings, 800 * mb)]
        let recs = RecommendationEngine.recommendations(candidates: candidates, protectedIDs: [], includeGuides: false)
        XCTAssertEqual(recs.map(\.id), [CandidateKind.screenRecordings.rawValue, CandidateKind.largeDownloads.rawValue])
    }

    func testScoreRespondsToEachFactor() {
        let base = RecommendationEngine.score(bytes: 500 * mb, confidence: .measured, risk: .low, effort: .quick, reversibility: .recentlyDeleted)
        XCTAssertGreaterThan(RecommendationEngine.score(bytes: 900 * mb, confidence: .measured, risk: .low, effort: .quick, reversibility: .recentlyDeleted), base)
        XCTAssertLessThan(RecommendationEngine.score(bytes: 500 * mb, confidence: .estimated, risk: .low, effort: .quick, reversibility: .recentlyDeleted), base)
        XCTAssertLessThan(RecommendationEngine.score(bytes: 500 * mb, confidence: .measured, risk: .medium, effort: .quick, reversibility: .recentlyDeleted), base)
        XCTAssertLessThan(RecommendationEngine.score(bytes: 500 * mb, confidence: .measured, risk: .low, effort: .involved, reversibility: .recentlyDeleted), base)
        XCTAssertLessThan(RecommendationEngine.score(bytes: 500 * mb, confidence: .measured, risk: .low, effort: .quick, reversibility: .permanent), base)
        XCTAssertEqual(RecommendationEngine.score(bytes: 0, confidence: .measured, risk: .low, effort: .quick, reversibility: .permanent), 0)
    }

    func testConfidenceOfAggregateIsWeakest() {
        let candidates = [single("a", .largeVideos, 100 * mb, .measured), single("b", .largeVideos, 100 * mb, .estimated)]
        let rec = RecommendationEngine.recommendations(candidates: candidates, protectedIDs: [], includeGuides: false).first
        XCTAssertEqual(rec?.estimate?.confidence, .estimated)
    }

    func testValuableSignsRaiseRisk() {
        var candidate = single("a", .screenRecordings, 100 * mb)
        candidate.hasValuableSigns = true
        let rec = RecommendationEngine.recommendations(candidates: [candidate], protectedIDs: [], includeGuides: false).first
        XCTAssertEqual(rec?.risk, .medium)
        XCTAssertEqual(rec?.hasValuableSigns, true)
    }

    func testGuidesNeverPromiseSavings() {
        let guides = RecommendationEngine.guideRecommendations()
        XCTAssertTrue(guides.allSatisfy { $0.estimate == nil && $0.itemCount == 0 })
        XCTAssertTrue(guides.contains { $0.tier == .maintenance })
        XCTAssertTrue(guides.contains { $0.tier == .highImpact })
    }
}

final class ProtectedExclusionTests: XCTestCase {
    func testProtectedSingleItemIsDropped() {
        let candidate = CleanupCandidate(id: "c", kind: .largeVideos, members: [.init(id: "photo:1", bytes: 500)], confidence: .estimated)
        XCTAssertNil(RecommendationEngine.reclaimable(candidate, protectedIDs: ["photo:1"]))
        let recs = RecommendationEngine.recommendations(candidates: [candidate], protectedIDs: ["photo:1"], includeGuides: false)
        XCTAssertTrue(recs.isEmpty)
    }

    func testGroupWithoutProtectionKeepsLargestCopy() {
        let candidate = CleanupCandidate(id: "g", kind: .duplicateFiles,
                                         members: [.init(id: "a", bytes: 100), .init(id: "b", bytes: 100), .init(id: "c", bytes: 100)],
                                         confidence: .reported)
        let result = RecommendationEngine.reclaimable(candidate, protectedIDs: [])
        XCTAssertEqual(result?.bytes, 200)
        XCTAssertEqual(result?.items, 2)
    }

    func testProtectedMemberBecomesTheKeptCopy() {
        let candidate = CleanupCandidate(id: "g", kind: .duplicateFiles,
                                         members: [.init(id: "a", bytes: 100), .init(id: "b", bytes: 100), .init(id: "c", bytes: 100)],
                                         confidence: .reported)
        let result = RecommendationEngine.reclaimable(candidate, protectedIDs: ["a"])
        XCTAssertEqual(result?.bytes, 200)
        XCTAssertEqual(result?.excluded, 1)
        let recs = RecommendationEngine.recommendations(candidates: [candidate], protectedIDs: ["a"], includeGuides: false)
        XCTAssertEqual(recs.first?.protectedItemsExcluded, 1)
    }

    func testFullyProtectedGroupIsDropped() {
        let candidate = CleanupCandidate(id: "g", kind: .similarPhotos,
                                         members: [.init(id: "a", bytes: 10), .init(id: "b", bytes: 10)], confidence: .estimated)
        XCTAssertNil(RecommendationEngine.reclaimable(candidate, protectedIDs: ["a", "b"]))
    }

    func testProtectionHelpers() {
        XCTAssertEqual(Protection.excluding(["a", "b", "c"], protected: ["b"]), ["a", "c"])
        let original = ProtectedItem(id: "x", kind: .file, displayName: "Mix.wav", location: "/", bytes: 1, backupStatus: .none,
                                     protectedOn: Date(timeIntervalSince1970: 100))
        var updated = original
        updated.backupStatus = .assumed
        updated.protectedOn = Date(timeIntervalSince1970: 999)
        let merged = Protection.upsert(updated, into: [original])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].backupStatus, .assumed)
        XCTAssertEqual(merged[0].protectedOn, Date(timeIntervalSince1970: 100), "keeps the original protection date")
        XCTAssertFalse(BackupStatus.userSelectable.contains(.verified), "only the app can mark a backup verified")
    }
}

final class ClassificationTests: XCTestCase {
    func testCategories() {
        XCTAssertEqual(FileCategory.classify(fileExtension: "MOV"), .video)
        XCTAssertEqual(FileCategory.classify(fileExtension: "wav"), .audio)
        XCTAssertEqual(FileCategory.classify(fileExtension: "heic"), .image)
        XCTAssertEqual(FileCategory.classify(fileExtension: "zip"), .archive)
        XCTAssertEqual(FileCategory.classify(fileExtension: "pdf"), .document)
        XCTAssertEqual(FileCategory.classify(fileExtension: "als"), .project)
        XCTAssertEqual(FileCategory.classify(fileExtension: "xyz"), .other)
    }

    func testValuableDetection() {
        XCTAssertFalse(ValuableContentDetector.reasons(fileName: "Summer Mix FINAL.wav", category: .audio).isEmpty)
        XCTAssertEqual(ValuableContentDetector.reasons(fileName: "Session.als", category: .project).count, 2)
        XCTAssertTrue(ValuableContentDetector.reasons(fileName: "invoice.pdf", category: .document).isEmpty)
        XCTAssertFalse(ValuableContentDetector.reasons(isFavorite: true, hasEdits: false, isScreenCapture: false, durationSeconds: 0).isEmpty)
        XCTAssertTrue(ValuableContentDetector.reasons(isFavorite: false, hasEdits: false, isScreenCapture: true, durationSeconds: 900).isEmpty)
        XCTAssertFalse(ValuableContentDetector.reasons(isFavorite: false, hasEdits: false, isScreenCapture: false, durationSeconds: 900).isEmpty)
    }

    func testRedundantExportNormalization() {
        XCTAssertEqual(RedundantExportDetector.normalizedStem("Mix (1).wav"), "mix")
        XCTAssertEqual(RedundantExportDetector.normalizedStem("Mix copy 2.wav"), "mix")
        XCTAssertEqual(RedundantExportDetector.normalizedStem("Mix_v3.wav"), "mix")
        XCTAssertEqual(RedundantExportDetector.normalizedStem("Mix final (2).wav"), "mix")
        XCTAssertEqual(RedundantExportDetector.normalizedStem("Track 1.wav"), "track 1")
    }

    func testRedundantGroupsStayWithinFolderAndExtension() {
        let inputs = [
            RedundantExportDetector.Input(id: "1", fileName: "Mix.wav", directory: "A", size: 100),
            RedundantExportDetector.Input(id: "2", fileName: "Mix (1).wav", directory: "A", size: 90),
            RedundantExportDetector.Input(id: "3", fileName: "Mix copy.wav", directory: "A", size: 80),
            RedundantExportDetector.Input(id: "4", fileName: "Mix.wav", directory: "B", size: 100),
            RedundantExportDetector.Input(id: "5", fileName: "Mix.mp3", directory: "A", size: 10),
            RedundantExportDetector.Input(id: "6", fileName: "Track 1.wav", directory: "A", size: 50),
            RedundantExportDetector.Input(id: "7", fileName: "Track 2.wav", directory: "A", size: 50),
        ]
        let groups = RedundantExportDetector.groups(inputs)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].map(\.id)), ["1", "2", "3"])
    }
}
