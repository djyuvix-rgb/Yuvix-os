import XCTest
@testable import SpaceMate

final class FileHasherTests: XCTestCase {
    var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testKnownVectors() throws {
        XCTAssertEqual(FileHasher.sha256(of: Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let empty = directory.appendingPathComponent("empty")
        try Data().write(to: empty)
        XCTAssertEqual(try FileHasher.sha256(of: empty), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    func testStreamingMatchesInMemoryAcrossChunks() throws {
        var bytes = [UInt8](repeating: 0, count: FileHasher.chunkSize * 2 + 123)
        for i in bytes.indices { bytes[i] = UInt8(truncatingIfNeeded: i &* 31) }
        let data = Data(bytes)
        let url = directory.appendingPathComponent("big.bin")
        try data.write(to: url)
        XCTAssertEqual(try FileHasher.sha256(of: url), FileHasher.sha256(of: data))

        var streaming = StreamingSHA256()
        streaming.update(data.prefix(1000))
        streaming.update(data.dropFirst(1000))
        XCTAssertEqual(streaming.finalize(), FileHasher.sha256(of: data))
        XCTAssertEqual(streaming.byteCount, Int64(data.count))
    }

    func testMissingFileThrows() {
        XCTAssertThrowsError(try FileHasher.sha256(of: directory.appendingPathComponent("nope")))
    }
}

final class DuplicateFinderTests: XCTestCase {
    struct Item { let id: String; let size: Int64; let hash: String? }

    func testSizeCollisionsSkipUniqueAndEmpty() {
        let items = [Item(id: "a", size: 10, hash: nil), Item(id: "b", size: 10, hash: nil),
                     Item(id: "c", size: 20, hash: nil), Item(id: "d", size: 0, hash: nil), Item(id: "e", size: 0, hash: nil)]
        let ids = Set(DuplicateFinder.sizeCollisions(items, size: \.size).map(\.id))
        XCTAssertEqual(ids, ["a", "b"])
    }

    func testExactGroupsRequireMatchingHash() {
        let items = [
            Item(id: "a", size: 100, hash: "h1"), Item(id: "b", size: 100, hash: "h1"), Item(id: "c", size: 100, hash: "h1"),
            Item(id: "d", size: 100, hash: "h2"), Item(id: "e", size: 100, hash: nil), Item(id: "f", size: 5, hash: "h3"),
            Item(id: "g", size: 5, hash: "h3"),
        ]
        let groups = DuplicateFinder.exactGroups(items, id: \.id, hash: \.hash, size: \.size)
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].memberIDs, ["a", "b", "c"], "largest savings first")
        XCTAssertEqual(groups[0].reclaimableBytes, 200)
        XCTAssertEqual(groups[1].reclaimableBytes, 5)
        XCTAssertFalse(groups.contains { $0.memberIDs.contains("e") }, "unhashed items are never grouped")
    }

    func testConservativeSavingsKeepsLargest() {
        XCTAssertEqual(DuplicateFinder.conservativeSavings(memberSizes: [100, 300, 200]), 300)
        XCTAssertEqual(DuplicateFinder.conservativeSavings(memberSizes: [100]), 0)
        XCTAssertEqual(DuplicateFinder.conservativeSavings(memberSizes: []), 0)
    }
}

final class PerceptualHashTests: XCTestCase {
    private func pixels(_ f: (Int, Int) -> Int) -> [UInt8] {
        var result: [UInt8] = []
        for row in 0..<8 { for col in 0..<9 { result.append(UInt8(clamping: f(row, col))) } }
        return result
    }

    func testIdenticalImagesHaveZeroDistance() {
        let a = PerceptualHash(grayscale: pixels { r, c in r * 20 + c * 7 })!
        let b = PerceptualHash(grayscale: pixels { r, c in r * 20 + c * 7 })!
        XCTAssertEqual(a.distance(to: b), 0)
    }

    func testBrightnessShiftKeepsHash() {
        let a = PerceptualHash(grayscale: pixels { r, c in (r * 13 + c * 29) % 200 })!
        let b = PerceptualHash(grayscale: pixels { r, c in (r * 13 + c * 29) % 200 + 40 })!
        XCTAssertEqual(a.distance(to: b), 0, "dHash compares neighbours, so uniform brightening shouldn't change it")
    }

    func testOppositeGradientsAreFarApart() {
        let rising = PerceptualHash(grayscale: pixels { _, c in c * 25 })!
        let falling = PerceptualHash(grayscale: pixels { _, c in 250 - c * 25 })!
        XCTAssertEqual(rising.distance(to: falling), 64)
    }

    func testRejectsWrongSize() {
        XCTAssertNil(PerceptualHash(grayscale: [1, 2, 3]))
    }

    func testGrouperGroupsOnlyCloseHashes() {
        let base: UInt64 = 0xF0F0_F0F0_0F0F_0F0F
        let images = [
            HashedImage(id: "a", hash: PerceptualHash(value: base), date: Date(timeIntervalSince1970: 0)),
            HashedImage(id: "b", hash: PerceptualHash(value: base ^ 0b111), date: Date(timeIntervalSince1970: 1)),   // distance 3
            HashedImage(id: "c", hash: PerceptualHash(value: ~base), date: Date(timeIntervalSince1970: 2)),          // far away
            HashedImage(id: "d", hash: PerceptualHash(value: ~base ^ 0b1), date: Date(timeIntervalSince1970: 3)),    // close to c
            HashedImage(id: "e", hash: PerceptualHash(value: 0x1234_5678_9ABC_DEF0), date: nil),
        ]
        let groups = SimilarityGrouper.groups(images).map { Set($0) }
        XCTAssertEqual(groups.count, 2)
        XCTAssertTrue(groups.contains(["a", "b"]))
        XCTAssertTrue(groups.contains(["c", "d"]))
    }

    func testLargeLibraryStillFindsExactMatchesFarApartInTime() {
        var images: [HashedImage] = []
        var generator = SystemRandomNumberGenerator()
        for i in 0..<(SimilarityGrouper.fullComparisonLimit + 200) {
            images.append(HashedImage(id: "r\(i)", hash: PerceptualHash(value: generator.next()), date: Date(timeIntervalSince1970: Double(i))))
        }
        let shared: UInt64 = 0xDEAD_BEEF_CAFE_F00D
        images.append(HashedImage(id: "first", hash: PerceptualHash(value: shared), date: Date(timeIntervalSince1970: -1)))
        images.append(HashedImage(id: "last", hash: PerceptualHash(value: shared), date: Date(timeIntervalSince1970: 1e9)))
        let groups = SimilarityGrouper.groups(images)
        XCTAssertTrue(groups.contains { Set($0).isSuperset(of: ["first", "last"]) })
    }

    func testFewerThanTwoImagesYieldNoGroups() {
        XCTAssertTrue(SimilarityGrouper.groups([]).isEmpty)
        XCTAssertTrue(SimilarityGrouper.groups([HashedImage(id: "x", hash: PerceptualHash(value: 1), date: nil)]).isEmpty)
    }
}
