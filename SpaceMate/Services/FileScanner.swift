import Foundation

/// A file the user gave SpaceMate access to through the Files picker.
struct ScannedFile: Identifiable, Hashable {
    let id: String
    let url: URL
    let name: String
    /// Path shown to the user, starting at the folder they picked.
    let displayPath: String
    let directory: String
    /// Logical file size reported by iOS.
    let size: Int64
    /// Space the file actually occupies on this iPhone. Zero for cloud files not downloaded.
    let localBytes: Int64
    let modified: Date?
    let category: FileCategory
    let isCloudItem: Bool
    let isDownloaded: Bool
    let isInDownloadsFolder: Bool
    let isPackage: Bool
    var sha256: String?

    var valuableReasons: [String] { ValuableContentDetector.reasons(fileName: name, category: category) }

    var sizeEstimate: ByteEstimate { ByteEstimate(bytes: localBytes, confidence: .reported) }
}

struct ScanIssue: Identifiable, Hashable {
    var id: String { path }
    let path: String
    let message: String
}

struct ScanResult {
    var files: [ScannedFile] = []
    var issues: [ScanIssue] = []
}

/// Walks the folders and files the user picked. The caller is responsible for
/// security-scoped access; this type only uses plain `FileManager` APIs.
struct FileScanner {
    static let resourceKeys: [URLResourceKey] = [
        .isRegularFileKey, .isDirectoryKey, .isPackageKey, .isSymbolicLinkKey,
        .fileSizeKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey,
        .contentModificationDateKey, .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey,
    ]

    var fileManager = FileManager.default

    func scan(roots: [URL], progress: ((Int) -> Void)? = nil) throws -> ScanResult {
        var result = ScanResult()
        var seen = Set<String>()
        for root in roots {
            try Task.checkCancellation()
            let rootValues = try? root.resourceValues(forKeys: Set(Self.resourceKeys))
            let rootName = root.lastPathComponent
            if rootValues?.isDirectory == true && rootValues?.isPackage != true {
                guard let enumerator = fileManager.enumerator(
                    at: root,
                    includingPropertiesForKeys: Self.resourceKeys,
                    options: [.skipsPackageDescendants],
                    errorHandler: { url, error in
                        result.issues.append(ScanIssue(path: url.path, message: error.localizedDescription))
                        return true
                    }
                ) else {
                    result.issues.append(ScanIssue(path: root.path, message: "Couldn't open this folder."))
                    continue
                }
                for case let url as URL in enumerator {
                    try Task.checkCancellation()
                    if let file = makeFile(url: url, root: root, rootName: rootName, issues: &result.issues),
                       seen.insert(file.id).inserted {
                        result.files.append(file)
                        progress?(result.files.count)
                    }
                }
            } else if let file = makeFile(url: root, root: root.deletingLastPathComponent(), rootName: root.deletingLastPathComponent().lastPathComponent, issues: &result.issues),
                      seen.insert(file.id).inserted {
                result.files.append(file)
                progress?(result.files.count)
            }
        }
        result.files.sort { $0.localBytes > $1.localBytes }
        return result
    }

    private func makeFile(url: URL, root: URL, rootName: String, issues: inout [ScanIssue]) -> ScannedFile? {
        let values: URLResourceValues
        do {
            values = try url.resourceValues(forKeys: Set(Self.resourceKeys))
        } catch {
            issues.append(ScanIssue(path: url.path, message: error.localizedDescription))
            return nil
        }
        if values.isSymbolicLink == true { return nil }
        let isPackage = values.isPackage == true
        guard values.isRegularFile == true || isPackage else { return nil }

        var size = Int64(values.fileSize ?? 0)
        var allocated = Int64(values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? values.fileSize ?? 0)
        if isPackage {
            (size, allocated) = packageSize(url)
        }
        let isCloud = values.isUbiquitousItem == true
        let downloaded: Bool
        if isCloud, let status = values.ubiquitousItemDownloadingStatus {
            downloaded = status != .notDownloaded
        } else {
            downloaded = true
        }
        let rootPath = root.resolvingSymlinksInPath().path
        let fullPath = url.resolvingSymlinksInPath().path
        let relative = fullPath.hasPrefix(rootPath) ? String(fullPath.dropFirst(rootPath.count)) : "/" + url.lastPathComponent
        let displayPath = rootName + relative
        let directory = (displayPath as NSString).deletingLastPathComponent
        let inDownloads = displayPath.split(separator: "/").dropLast().contains { $0.lowercased() == "downloads" }

        return ScannedFile(
            id: ItemID.file(url),
            url: url,
            name: url.lastPathComponent,
            displayPath: displayPath,
            directory: directory,
            size: size,
            localBytes: downloaded ? allocated : 0,
            modified: values.contentModificationDate,
            category: FileCategory.classify(fileExtension: url.pathExtension),
            isCloudItem: isCloud,
            isDownloaded: downloaded,
            isInDownloadsFolder: inDownloads,
            isPackage: isPackage,
            sha256: nil
        )
    }

    private func packageSize(_ url: URL) -> (Int64, Int64) {
        var logical: Int64 = 0
        var allocated: Int64 = 0
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .totalFileAllocatedSizeKey]
        guard let enumerator = fileManager.enumerator(at: url, includingPropertiesForKeys: keys) else { return (0, 0) }
        for case let child as URL in enumerator {
            guard let values = try? child.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            logical += Int64(values.fileSize ?? 0)
            allocated += Int64(values.totalFileAllocatedSize ?? values.fileSize ?? 0)
        }
        return (logical, allocated)
    }

    /// Hashes only files that could have a duplicate (same size), are on this iPhone, and aren't packages.
    /// Reading a cloud file that isn't downloaded would trigger a download, so those are skipped.
    static func hashCandidates(_ files: [ScannedFile]) -> [ScannedFile] {
        let eligible = files.filter { $0.isDownloaded && !$0.isPackage && $0.size > 0 }
        return DuplicateFinder.sizeCollisions(eligible, size: \.size)
    }
}

/// Deletes and verifies files. Every operation reports what actually happened.
struct FileOperations {
    enum DeleteResult: Equatable {
        case deleted
        case failed(String)
    }

    var fileManager = FileManager.default

    /// Deletes one file using file coordination (so file providers such as iCloud Drive are notified),
    /// then checks it is really gone.
    func delete(_ url: URL) -> DeleteResult {
        guard fileManager.fileExists(atPath: url.path) else { return .failed("File no longer exists at this location.") }
        var coordinationError: NSError?
        var operationError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forDeleting, error: &coordinationError) { coordinatedURL in
            do {
                try fileManager.removeItem(at: coordinatedURL)
            } catch {
                operationError = error
            }
        }
        if let error = coordinationError ?? operationError.map({ $0 as NSError }) {
            return .failed(error.localizedDescription)
        }
        return fileManager.fileExists(atPath: url.path) ? .failed("iOS reported success but the file is still present.") : .deleted
    }

    /// True only when both files can be read and their SHA-256 hashes match.
    static func verifyCopy(original: URL, copy: URL) -> Bool {
        guard let a = try? FileHasher.sha256(of: original), let b = try? FileHasher.sha256(of: copy) else { return false }
        return a == b
    }
}
