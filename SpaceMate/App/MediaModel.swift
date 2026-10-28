import Observation
import Photos
import SwiftUI

enum MediaSort: String, CaseIterable, Identifiable {
    case size, duration, date
    var id: String { rawValue }
    var label: String {
        switch self {
        case .size: return "Largest"
        case .duration: return "Longest"
        case .date: return "Newest"
        }
    }
}

struct SimilarGroup: Identifiable, Hashable {
    enum Verification: Hashable {
        case unchecked
        case checking
        /// Every member's stored bytes hash identically.
        case identical
        case different
        case couldNotCheck(String)
    }

    let id: String
    var memberIDs: [String]
    var verification: Verification = .unchecked
}

enum MeasureState: Hashable {
    case measuring
    case notOnDevice
    case failed(String)
}

struct MediaDeletionReport: Identifiable {
    let id = UUID()
    let requested: Int
    let deleted: Int
    let estimated: ByteEstimate
    let measuredChange: Int64?
    let message: String?
}

/// Photo-library analysis state. Heavy work runs off the main thread with progress and cancellation.
@MainActor
@Observable
final class MediaModel {
    private(set) var access: MediaAccess = PhotoLibraryService.currentAccess()
    private(set) var videos: [MediaItem] = []
    private(set) var screenshots: [MediaItem] = []
    private(set) var similarGroups: [SimilarGroup] = []
    private(set) var itemsByID: [String: MediaItem] = [:]

    private(set) var isAnalyzing = false
    private(set) var isFindingSimilar = false
    private(set) var similarProgress: Double = 0
    private(set) var similarScanned = 0
    private(set) var similarTotal = 0
    private(set) var hasAnalyzed = false
    private(set) var hasFoundSimilar = false
    private(set) var measureStates: [String: MeasureState] = [:]
    private(set) var measuringCount = 0
    private(set) var isMeasuring = false
    var selectedIDs: Set<String> = []
    var errorMessage: String?

    @ObservationIgnored let service = PhotoLibraryService()
    @ObservationIgnored private var similarTask: Task<Void, Never>?
    @ObservationIgnored private var measureTask: Task<Void, Never>?

    // MARK: Derived lists

    func largeVideos(threshold: Int64) -> [MediaItem] {
        videos.filter { $0.kind == .video && $0.size.bytes >= threshold }
    }

    var screenRecordings: [MediaItem] { videos.filter { $0.kind == .screenRecording } }

    var analyzedCount: Int { itemsByID.count }
    var analyzedBytes: ByteEstimate { itemsByID.values.map(\.size).total() }

    var selectedItems: [MediaItem] { selectedIDs.compactMap { itemsByID[$0] } }

    func items(_ ids: [String]) -> [MediaItem] { ids.compactMap { itemsByID[$0] } }

    static func sorted(_ items: [MediaItem], by sort: MediaSort) -> [MediaItem] {
        switch sort {
        case .size: return items.sorted { $0.size.bytes > $1.size.bytes }
        case .duration: return items.sorted { $0.duration > $1.duration }
        case .date: return items.sorted { ($0.creationDate ?? .distantPast) > ($1.creationDate ?? .distantPast) }
        }
    }

    func candidates(settings: AppSettings) -> [CleanupCandidate] {
        var result: [CleanupCandidate] = []
        for item in screenRecordings where item.duration >= settings.longScreenRecordingSeconds {
            result.append(single(item, kind: .screenRecordings))
        }
        for item in largeVideos(threshold: settings.largeVideoThreshold) {
            result.append(single(item, kind: .largeVideos))
        }
        for item in screenshots {
            result.append(single(item, kind: .screenshots))
        }
        for group in similarGroups {
            let members = items(group.memberIDs)
            guard members.count > 1 else { continue }
            result.append(CleanupCandidate(
                id: "similar:\(group.id)", kind: .similarPhotos,
                members: members.map { .init(id: $0.id, bytes: $0.size.bytes) },
                confidence: members.map(\.size.confidence).min() ?? .estimated,
                hasValuableSigns: members.contains { !$0.valuableReasons.isEmpty }
            ))
        }
        return result
    }

    private func single(_ item: MediaItem, kind: CandidateKind) -> CleanupCandidate {
        CleanupCandidate(
            id: "\(kind.rawValue):\(item.id)", kind: kind,
            members: [.init(id: item.id, bytes: item.size.bytes)],
            confidence: item.size.confidence,
            hasValuableSigns: !item.valuableReasons.isEmpty
        )
    }

    // MARK: Access and analysis

    func refreshAccess() {
        access = PhotoLibraryService.currentAccess()
    }

    func requestAccessAndAnalyze() async {
        if access == .notDetermined {
            access = await PhotoLibraryService.requestAccess()
        } else {
            refreshAccess()
        }
        if access.canAnalyze { await analyze() }
    }

    func presentLimitedPicker() async {
        _ = await PhotoLibraryService.presentLimitedLibraryPicker()
        refreshAccess()
        await analyze()
        if hasFoundSimilar { findSimilar() }
    }

    /// Fetches videos and screenshots. Fast: metadata only, no image data is read.
    func analyze() async {
        guard access.canAnalyze, !isAnalyzing else { return }
        isAnalyzing = true
        let service = self.service
        let (fetchedVideos, fetchedShots) = await Task.detached(priority: .userInitiated) {
            (service.fetchVideos(), service.fetchScreenshots())
        }.value
        // Keep exact measurements from earlier in this session.
        let previous = itemsByID
        func merge(_ item: MediaItem) -> MediaItem {
            guard let old = previous[item.id], old.size.confidence == .measured || old.originalNotOnDevice else { return item }
            var updated = item
            updated.size = old.size
            updated.originalNotOnDevice = old.originalNotOnDevice
            return updated
        }
        videos = fetchedVideos.map(merge)
        screenshots = fetchedShots.map(merge)
        var map = itemsByID.filter { $0.value.kind == .photo }
        for item in videos + screenshots { map[item.id] = item }
        itemsByID = map
        selectedIDs = selectedIDs.filter { map[$0] != nil }
        hasAnalyzed = true
        isAnalyzing = false
    }

    /// Hashes every photo's small cached thumbnail and groups look-alikes. Cancellable.
    func findSimilar() {
        guard access.canAnalyze, !isFindingSimilar else { return }
        isFindingSimilar = true
        similarProgress = 0
        similarScanned = 0
        let service = self.service
        similarTask = Task { [weak self] in
            let fetch = service.fetchPhotosForSimilarity()
            let total = fetch.count
            self?.similarTotal = total
            var hashed: [HashedImage] = []
            var assetsByID: [String: PHAsset] = [:]
            hashed.reserveCapacity(total)
            for index in 0..<total {
                if Task.isCancelled { break }
                let asset = fetch.object(at: index)
                if let hash = await service.perceptualHash(for: asset) {
                    let id = ItemID.photo(asset.localIdentifier)
                    hashed.append(HashedImage(id: id, hash: hash, date: asset.creationDate))
                    assetsByID[id] = asset
                }
                if index % 25 == 0 || index == total - 1 {
                    self?.similarScanned = index + 1
                    self?.similarProgress = total > 0 ? Double(index + 1) / Double(total) : 1
                }
            }
            let cancelled = Task.isCancelled
            let images = hashed
            let groups = await Task.detached(priority: .userInitiated) {
                SimilarityGrouper.groups(images)
            }.value
            guard let self else { return }
            var map = self.itemsByID
            for ids in groups {
                for id in ids where map[id] == nil {
                    if let asset = assetsByID[id] { map[id] = PhotoLibraryService.item(from: asset) }
                }
            }
            self.itemsByID = map
            self.similarGroups = groups.map { SimilarGroup(id: $0.min() ?? UUID().uuidString, memberIDs: $0) }
            self.hasFoundSimilar = !cancelled
            self.isFindingSimilar = false
            if cancelled { self.errorMessage = "Similar-photo search was stopped after \(self.similarScanned) of \(total) photos. Results cover only those." }
        }
    }

    func cancelSimilar() { similarTask?.cancel() }

    // MARK: Exact measurement

    /// Replaces estimates with bytes counted from items stored on this iPhone. Never downloads.
    func measure(ids: [String]) {
        guard measureTask == nil else { return }
        let targets = ids.filter { itemsByID[$0]?.size.confidence != .measured }
        guard !targets.isEmpty else { return }
        measuringCount = targets.count
        isMeasuring = true
        let service = self.service
        measureTask = Task { [weak self] in
            for id in targets {
                if Task.isCancelled { break }
                guard let self, let item = self.itemsByID[id] else { continue }
                self.measureStates[id] = .measuring
                let (result, _) = await service.measure(localIdentifier: item.localIdentifier)
                self.apply(result, to: id)
                self.measuringCount -= 1
            }
            self?.measuringCount = 0
            self?.isMeasuring = false
            self?.measureTask = nil
        }
    }

    func cancelMeasuring() { measureTask?.cancel() }

    private func apply(_ result: MeasureResult, to id: String) {
        guard var item = itemsByID[id] else { return }
        switch result {
        case .measured(let bytes):
            item.size = ByteEstimate(bytes: bytes, confidence: .measured)
            item.originalNotOnDevice = false
            measureStates[id] = nil
        case .notOnDevice:
            item.originalNotOnDevice = true
            measureStates[id] = .notOnDevice
        case .failed(let message):
            measureStates[id] = .failed(message)
        }
        update(item)
    }

    private func update(_ item: MediaItem) {
        itemsByID[item.id] = item
        if let index = videos.firstIndex(where: { $0.id == item.id }) { videos[index] = item }
        if let index = screenshots.firstIndex(where: { $0.id == item.id }) { screenshots[index] = item }
    }

    /// Checks whether a look-alike group is byte-for-byte identical by hashing each original stored on
    /// this iPhone. Only then is it called a duplicate.
    func verifyIdentical(groupID: String) async {
        guard let index = similarGroups.firstIndex(where: { $0.id == groupID }) else { return }
        similarGroups[index].verification = .checking
        var hashes: Set<String> = []
        var problem: String?
        for id in similarGroups[index].memberIDs {
            guard let item = itemsByID[id] else { continue }
            let (result, hash) = await service.measure(localIdentifier: item.localIdentifier, computeHash: true)
            apply(result, to: id)
            switch result {
            case .measured:
                if let hash { hashes.insert(hash) }
            case .notOnDevice:
                problem = "At least one original is stored only in iCloud, so it can't be compared without downloading."
            case .failed(let message):
                problem = message
            }
            if problem != nil { break }
        }
        guard let current = similarGroups.firstIndex(where: { $0.id == groupID }) else { return }
        if let problem {
            similarGroups[current].verification = .couldNotCheck(problem)
        } else {
            similarGroups[current].verification = hashes.count == 1 ? .identical : .different
        }
    }

    // MARK: Selection

    func toggleSelection(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) }
    }

    func deselect(ids: [String]) { selectedIDs.subtract(ids) }

    // MARK: Deletion

    /// Deletes exactly the given items after the user confirmed, then reports what actually changed.
    func delete(ids: [String], app: AppModel) async -> MediaDeletionReport {
        let protected = app.protectedIDs
        let targets = items(ids).filter { !protected.contains($0.id) }
        let estimate = targets.map(\.size).total()
        let before = app.refreshStorage()
        let outcome = await service.delete(localIdentifiers: targets.map(\.localIdentifier))
        switch outcome {
        case .deleted(let count):
            // Give the file system a moment to settle before measuring again.
            try? await Task.sleep(for: .seconds(1))
            let after = app.refreshStorage()
            let stillPresent = Set(service.assets(for: targets.map(\.localIdentifier)).map { ItemID.photo($0.localIdentifier) })
            let removedIDs = Set(targets.map(\.id)).subtracting(stillPresent)
            removeLocally(removedIDs)
            let removedEstimate = targets.filter { removedIDs.contains($0.id) }.map(\.size).total()
            let session = CleanupSession(date: Date(), source: .photos, itemCount: count, estimated: removedEstimate, before: before, after: after,
                                         note: "Moved to Recently Deleted in Photos")
            app.record(session)
            return MediaDeletionReport(requested: targets.count, deleted: count, estimated: removedEstimate, measuredChange: session.measuredChange, message: nil)
        case .cancelledOrFailed(let message):
            return MediaDeletionReport(requested: targets.count, deleted: 0, estimated: estimate, measuredChange: nil, message: message)
        }
    }

    private func removeLocally(_ ids: Set<String>) {
        videos.removeAll { ids.contains($0.id) }
        screenshots.removeAll { ids.contains($0.id) }
        for id in ids { itemsByID[id] = nil }
        selectedIDs.subtract(ids)
        similarGroups = similarGroups.compactMap { group in
            var group = group
            group.memberIDs.removeAll { ids.contains($0) }
            return group.memberIDs.count > 1 ? group : nil
        }
    }

    func reset() {
        similarTask?.cancel()
        measureTask?.cancel()
        videos = []
        screenshots = []
        similarGroups = []
        itemsByID = [:]
        selectedIDs = []
        measureStates = [:]
        hasAnalyzed = false
        hasFoundSimilar = false
    }
}
