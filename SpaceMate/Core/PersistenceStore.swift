import Foundation

/// Saves `AppData` as a single JSON file in Application Support, with iOS data protection
/// so it is encrypted while the phone is locked. It holds no file contents or photos.
final class PersistenceStore {
    enum StoreError: Error {
        case writeFailed(Error)
    }

    let fileURL: URL

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        fileURL = base.appendingPathComponent("SpaceMate", isDirectory: true).appendingPathComponent("data.json")
    }

    /// Loads saved data. A missing or unreadable file yields empty data rather than a crash.
    func load() -> AppData {
        guard let data = try? Data(contentsOf: fileURL) else { return .empty }
        return (try? JSONDecoder().decode(AppData.self, from: data)) ?? .empty
    }

    func save(_ appData: AppData) throws {
        do {
            let data = try JSONEncoder().encode(appData)
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if os(iOS)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: fileURL, options: [.atomic])
            #endif
        } catch {
            throw StoreError.writeFailed(error)
        }
    }

    func erase() throws {
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.removeItem(at: fileURL)
        }
    }
}
