import Observation
import SwiftUI

enum AppTab: Hashable {
    case home, media, files, plan, routine
}

/// App-wide state: device storage readings, persisted data, protection and history.
@MainActor
@Observable
final class AppModel {
    private(set) var data: AppData
    private(set) var snapshot: StorageSnapshot?
    private(set) var storageError: String?
    private(set) var saveError: String?
    var selectedTab: AppTab = .home

    let media: MediaModel
    let files: FilesModel

    @ObservationIgnored private let store: PersistenceStore

    init(store: PersistenceStore = PersistenceStore()) {
        self.store = store
        data = store.load()
        media = MediaModel()
        files = FilesModel()
    }

    var settings: AppSettings { data.settings }

    // MARK: Storage

    @discardableResult
    func refreshStorage() -> StorageSnapshot? {
        do {
            let reading = try StorageService.currentSnapshot()
            snapshot = reading
            storageError = nil
            data.snapshots = StorageHistory.appending(reading, to: data.snapshots)
            persist()
            return reading
        } catch {
            storageError = error.localizedDescription
            return nil
        }
    }

    var bytesNeededForTarget: Int64 {
        guard let snapshot else { return 0 }
        return StorageMath.bytesNeeded(toReach: settings.freeSpaceTarget, available: snapshot.available)
    }

    // MARK: Recommendations

    var protectedIDs: Set<String> { Set(data.protectedItems.map(\.id)) }

    var candidates: [CleanupCandidate] {
        media.candidates(settings: settings) + files.candidates(settings: settings)
    }

    var recommendations: [Recommendation] {
        RecommendationEngine.recommendations(candidates: candidates, protectedIDs: protectedIDs)
    }

    var candidateTotal: ByteEstimate {
        RecommendationEngine.totalEstimate(recommendations)
    }

    /// Estimated savings for everything the user has currently ticked, protected items excluded.
    var selectedTotal: ByteEstimate {
        let ids = protectedIDs
        let mediaSizes = media.selectedItems.filter { !ids.contains($0.id) }.map(\.size)
        let fileSizes = files.selectedFiles.filter { !ids.contains($0.id) }.map(\.sizeEstimate)
        return (mediaSizes + fileSizes).total()
    }

    // MARK: Protection

    func isProtected(_ id: String) -> Bool { protectedIDs.contains(id) }

    func protect(_ item: ProtectedItem) {
        data.protectedItems = Protection.upsert(item, into: data.protectedItems)
        media.deselect(ids: [item.id])
        files.deselect(ids: [item.id])
        persist()
    }

    func unprotect(id: String) {
        data.protectedItems.removeAll { $0.id == id }
        persist()
    }

    func setBackupStatus(_ status: BackupStatus, for id: String) {
        guard let index = data.protectedItems.firstIndex(where: { $0.id == id }) else { return }
        data.protectedItems[index].backupStatus = status
        data.protectedItems[index].backupCheckedOn = Date()
        persist()
    }

    func protectedItem(id: String) -> ProtectedItem? { data.protectedItems.first { $0.id == id } }

    func toggleProtection(media item: MediaItem) {
        if isProtected(item.id) {
            unprotect(id: item.id)
        } else {
            protect(ProtectedItem(
                id: item.id, kind: .photoAsset,
                displayName: item.kind == .photo ? "Photo" : (item.kind == .screenshot ? "Screenshot" : "Video"),
                location: "Photos · \(item.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "unknown date")",
                bytes: item.size.bytes, backupStatus: .none, protectedOn: Date()
            ))
        }
    }

    func toggleProtection(file: ScannedFile) {
        if isProtected(file.id) {
            unprotect(id: file.id)
        } else {
            protect(ProtectedItem(
                id: file.id, kind: .file, displayName: file.name, location: file.displayPath,
                bytes: file.localBytes, backupStatus: .none, protectedOn: Date()
            ))
        }
    }

    // MARK: History

    func record(_ session: CleanupSession) {
        data.sessions.append(session)
        persist()
    }

    func markMediaAnalyzed() {
        data.lastMediaAnalysis = Date()
        persist()
    }

    func markFilesScanned() {
        data.lastFileScan = Date()
        persist()
    }

    func clearHistory() {
        data.snapshots = []
        data.sessions = []
        data.lastMediaAnalysis = nil
        data.lastFileScan = nil
        persist()
        refreshStorage()
    }

    func clearProtectedItems() {
        data.protectedItems = []
        persist()
    }

    /// Removes everything SpaceMate stored and forgets in-memory analysis. Touches no photos or files.
    func eraseAllAppData() {
        try? store.erase()
        data = .empty
        media.reset()
        files.reset()
        NotificationService.cancelAll()
        refreshStorage()
    }

    // MARK: Settings

    func updateSettings(_ change: (inout AppSettings) -> Void) {
        change(&data.settings)
        persist()
    }

    /// Returns false when notifications aren't permitted.
    func applyReminderSettings() async -> Bool {
        if settings.reminderFrequency != .off {
            let status = await NotificationService.authorizationStatus()
            if status == .notDetermined {
                _ = await NotificationService.requestAuthorization()
            }
        }
        return await NotificationService.schedule(settings)
    }

    private func persist() {
        do {
            try store.save(data)
            saveError = nil
        } catch {
            saveError = "Couldn't save SpaceMate's data: \(error.localizedDescription)"
        }
    }
}
