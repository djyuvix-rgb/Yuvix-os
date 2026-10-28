import Observation
import SwiftUI

enum FileSort: String, CaseIterable, Identifiable {
    case size, name, date
    var id: String { rawValue }
    var label: String {
        switch self {
        case .size: return "Size"
        case .name: return "Name"
        case .date: return "Modified"
        }
    }
}

struct FileDeletionReport: Identifiable {
    let id = UUID()
    let deleted: [ScannedFile]
    let failures: [(name: String, reason: String)]
    let estimated: ByteEstimate
    let measuredChange: Int64?
}

/// State for files and folders the user picked in the Files app. SpaceMate only sees what was picked.
@MainActor
@Observable
final class FilesModel {
    private(set) var roots: [URL] = []
    private(set) var files: [ScannedFile] = []
    private(set) var issues: [ScanIssue] = []
    private(set) var duplicateGroups: [DuplicateGroup] = []
    private(set) var redundantGroups: [[ScannedFile]] = []
    private(set) var isScanning = false
    private(set) var scannedCount = 0
    private(set) var hashProgress: Double = 0
    private(set) var isHashing = false
    var selectedIDs: Set<String> = []
    var errorMessage: String?

    @ObservationIgnored private var accessedRoots: [URL] = []
    @ObservationIgnored private var scanTask: Task<Void, Never>?

    var hasScanned: Bool { !roots.isEmpty }
    var totalBytes: ByteEstimate { files.map(\.sizeEstimate).total() }
    var selectedFiles: [ScannedFile] { files.filter { selectedIDs.contains($0.id) } }

    func file(id: String) -> ScannedFile? { files.first { $0.id == id } }
    func files(withIDs ids: [String]) -> [ScannedFile] {
        let set = Set(ids)
        return files.filter { set.contains($0.id) }
    }

    var downloads: [ScannedFile] { files.filter(\.isInDownloadsFolder) }

    struct CategoryGroup: Identifiable {
        var id: FileCategory { category }
        let category: FileCategory
        let files: [ScannedFile]
    }

    func byCategory() -> [CategoryGroup] {
        let grouped = Dictionary(grouping: files, by: \.category)
        return FileCategory.allCases.compactMap { category in
            guard let list = grouped[category], !list.isEmpty else { return nil }
            return CategoryGroup(category: category, files: list)
        }
    }

    static func sorted(_ list: [ScannedFile], by sort: FileSort) -> [ScannedFile] {
        switch sort {
        case .size: return list.sorted { $0.localBytes > $1.localBytes }
        case .name: return list.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        case .date: return list.sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }
        }
    }

    // MARK: Candidates

    /// Each file contributes to at most one kind, so totals never double count.
    func candidates(settings: AppSettings) -> [CleanupCandidate] {
        var result: [CleanupCandidate] = []
        var used = Set<String>()
        let byID = Dictionary(uniqueKeysWithValues: files.map { ($0.id, $0) })

        for group in duplicateGroups {
            let members = group.memberIDs.compactMap { byID[$0] }
            guard members.count > 1 else { continue }
            used.formUnion(members.map(\.id))
            result.append(CleanupCandidate(
                id: "dup:\(group.id)", kind: .duplicateFiles,
                members: members.map { .init(id: $0.id, bytes: $0.localBytes) },
                confidence: .reported,
                hasValuableSigns: false // identical copies: keeping one loses nothing
            ))
        }
        for group in redundantGroups {
            let members = group.filter { !used.contains($0.id) }
            guard members.count > 1 else { continue }
            used.formUnion(members.map(\.id))
            result.append(CleanupCandidate(
                id: "versions:\(members[0].id)", kind: .redundantExports,
                members: members.map { .init(id: $0.id, bytes: $0.localBytes) },
                confidence: .reported,
                hasValuableSigns: members.contains { !$0.valuableReasons.isEmpty }
            ))
        }
        for file in files where !used.contains(file.id) && file.localBytes >= settings.largeFileThreshold {
            let kind: CandidateKind = file.isInDownloadsFolder ? .largeDownloads : .largeFiles
            result.append(CleanupCandidate(
                id: "\(kind.rawValue):\(file.id)", kind: kind,
                members: [.init(id: file.id, bytes: file.localBytes)],
                confidence: .reported,
                hasValuableSigns: !file.valuableReasons.isEmpty
            ))
        }
        return result
    }

    // MARK: Scanning

    /// Adds picked URLs (from the Files picker) and scans everything picked so far.
    func add(_ urls: [URL]) {
        for url in urls where !roots.contains(url) {
            if url.startAccessingSecurityScopedResource() {
                accessedRoots.append(url)
            }
            roots.append(url)
        }
        scan()
    }

    func scan() {
        scanTask?.cancel()
        isScanning = true
        scannedCount = 0
        errorMessage = nil
        let roots = self.roots
        scanTask = Task { [weak self] in
            let scanResult: ScanResult
            do {
                scanResult = try await Task.detached(priority: .userInitiated) {
                    try FileScanner().scan(roots: roots)
                }.value
            } catch {
                self?.isScanning = false
                self?.errorMessage = error is CancellationError ? "Scan cancelled." : error.localizedDescription
                return
            }
            guard let self else { return }
            self.files = scanResult.files
            self.issues = scanResult.issues
            self.scannedCount = scanResult.files.count
            self.isScanning = false
            self.selectedIDs = self.selectedIDs.filter { id in scanResult.files.contains { $0.id == id } }
            await self.findDuplicates()
        }
    }

    func cancelScan() { scanTask?.cancel() }

    /// Hashes same-size files with SHA-256 to find exact duplicates, then looks for repeated exports.
    private func findDuplicates() async {
        let candidates = FileScanner.hashCandidates(files)
        isHashing = true
        hashProgress = 0
        var hashes: [String: String] = [:]
        for (index, file) in candidates.enumerated() {
            if Task.isCancelled { break }
            let url = file.url
            let hash = await Task.detached(priority: .utility) { try? FileHasher.sha256(of: url) }.value
            if let hash { hashes[file.id] = hash }
            hashProgress = Double(index + 1) / Double(max(1, candidates.count))
        }
        for index in files.indices { files[index].sha256 = hashes[files[index].id] }
        duplicateGroups = DuplicateFinder.exactGroups(files, id: \.id, hash: \.sha256, size: \.localBytes)
        recomputeRedundant()
        isHashing = false
    }

    private func recomputeRedundant() {
        let byID = Dictionary(uniqueKeysWithValues: files.map { ($0.id, $0) })
        let inputs = files.filter { !$0.isPackage }.map {
            RedundantExportDetector.Input(id: $0.id, fileName: $0.name, directory: $0.directory, size: $0.localBytes)
        }
        redundantGroups = RedundantExportDetector.groups(inputs).map { $0.compactMap { byID[$0.id] } }
    }

    // MARK: Selection

    func toggleSelection(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) }
    }

    func deselect(ids: [String]) { selectedIDs.subtract(ids) }

    // MARK: Deletion

    /// Deletes exactly the files the user confirmed, skipping protected ones, and reports per-file results.
    func delete(ids: [String], app: AppModel) async -> FileDeletionReport {
        let protected = app.protectedIDs
        let targets = files(withIDs: ids).filter { !protected.contains($0.id) }
        let before = app.refreshStorage()
        var deleted: [ScannedFile] = []
        var failures: [(String, String)] = []
        for file in targets {
            let url = file.url
            let result = await Task.detached(priority: .userInitiated) { FileOperations().delete(url) }.value
            switch result {
            case .deleted: deleted.append(file)
            case .failed(let reason): failures.append((file.name, reason))
            }
        }
        let after = deleted.isEmpty ? nil : app.refreshStorage()
        let estimate = deleted.map(\.sizeEstimate).total()
        var measured: Int64?
        if !deleted.isEmpty {
            let session = CleanupSession(date: Date(), source: .files, itemCount: deleted.count, estimated: estimate, before: before, after: after,
                                         note: "Deleted permanently from Files")
            app.record(session)
            measured = session.measuredChange
            let removed = Set(deleted.map(\.id))
            files.removeAll { removed.contains($0.id) }
            selectedIDs.subtract(removed)
            duplicateGroups = DuplicateFinder.exactGroups(files, id: \.id, hash: \.sha256, size: \.localBytes)
            recomputeRedundant()
        }
        return FileDeletionReport(deleted: deleted, failures: failures.map { (name: $0.0, reason: $0.1) }, estimated: estimate, measuredChange: measured)
    }

    /// Stops security-scoped access and forgets everything scanned.
    func reset() {
        scanTask?.cancel()
        for url in accessedRoots { url.stopAccessingSecurityScopedResource() }
        accessedRoots = []
        roots = []
        files = []
        issues = []
        duplicateGroups = []
        redundantGroups = []
        selectedIDs = []
        isScanning = false
        isHashing = false
    }
}
