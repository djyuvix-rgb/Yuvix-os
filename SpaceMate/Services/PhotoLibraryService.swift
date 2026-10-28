import AVFoundation
import Photos
import UIKit

/// A photo-library item as SpaceMate sees it. Built from public `PHAsset` properties.
struct MediaItem: Identifiable, Hashable {
    enum Kind: String {
        case video, screenRecording, screenshot, photo
    }

    let id: String            // ItemID.photo(localIdentifier)
    let localIdentifier: String
    let kind: Kind
    let creationDate: Date?
    let duration: Double
    let pixelWidth: Int
    let pixelHeight: Int
    let isFavorite: Bool
    let hasEdits: Bool
    let isLivePhoto: Bool
    var size: ByteEstimate
    /// True when Photos reported that the original is not stored on this iPhone.
    var originalNotOnDevice = false

    var valuableReasons: [String] {
        ValuableContentDetector.reasons(
            isFavorite: isFavorite,
            hasEdits: hasEdits,
            isScreenCapture: kind == .screenRecording || kind == .screenshot,
            durationSeconds: duration
        )
    }

    var resolutionText: String { "\(pixelWidth) × \(pixelHeight)" }

    var durationText: String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = duration >= 3600 ? [.hour, .minute, .second] : [.minute, .second]
        formatter.zeroFormattingBehavior = .pad
        return formatter.string(from: duration) ?? ""
    }
}

/// The outcome of measuring an asset's real size on this iPhone.
enum MeasureResult {
    case measured(Int64)
    /// The original lives in iCloud; this iPhone has only an optimized version or none.
    case notOnDevice
    case failed(String)
}

enum DeletionOutcome {
    case deleted(count: Int)
    case cancelledOrFailed(String)
}

/// All PhotoKit access lives here. Uses documented APIs only.
final class PhotoLibraryService {
    let imageManager = PHCachingImageManager()

    // MARK: Permissions

    static func currentAccess() -> MediaAccess {
        map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    static func requestAccess() async -> MediaAccess {
        map(await PHPhotoLibrary.requestAuthorization(for: .readWrite))
    }

    static func map(_ status: PHAuthorizationStatus) -> MediaAccess {
        switch status {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        case .limited: return .limited
        case .authorized: return .full
        @unknown default: return .denied
        }
    }

    // MARK: Fetching

    /// All videos (camera videos and screen recordings) with estimated sizes.
    func fetchVideos() -> [MediaItem] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .video, options: options)
        var items: [MediaItem] = []
        items.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            items.append(Self.item(from: asset))
        }
        return items
    }

    func fetchScreenshots() -> [MediaItem] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "(mediaSubtypes & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var items: [MediaItem] = []
        result.enumerateObjects { asset, _, _ in items.append(Self.item(from: asset)) }
        return items
    }

    /// Photos that are not screenshots, newest first, for similarity analysis.
    func fetchPhotosForSimilarity() -> PHFetchResult<PHAsset> {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "(mediaSubtypes & %d) == 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
        return PHAsset.fetchAssets(with: .image, options: options)
    }

    func assets(for localIdentifiers: [String]) -> [PHAsset] {
        guard !localIdentifiers.isEmpty else { return [] }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: localIdentifiers, options: nil)
        var assets: [PHAsset] = []
        result.enumerateObjects { asset, _, _ in assets.append(asset) }
        return assets
    }

    static func item(from asset: PHAsset) -> MediaItem {
        let kind: MediaItem.Kind
        if asset.mediaType == .video {
            kind = asset.mediaSubtypes.contains(.videoScreenRecording) ? .screenRecording : .video
        } else {
            kind = asset.mediaSubtypes.contains(.photoScreenshot) ? .screenshot : .photo
        }
        let isLive = asset.mediaSubtypes.contains(.photoLive)
        let bytes: Int64
        if asset.mediaType == .video {
            bytes = MediaSizeEstimator.videoBytes(
                pixelWidth: asset.pixelWidth, pixelHeight: asset.pixelHeight,
                durationSeconds: asset.duration, isScreenRecording: kind == .screenRecording
            )
        } else {
            bytes = MediaSizeEstimator.photoBytes(
                pixelWidth: asset.pixelWidth, pixelHeight: asset.pixelHeight,
                isScreenshot: kind == .screenshot, isLivePhoto: isLive
            )
        }
        return MediaItem(
            id: ItemID.photo(asset.localIdentifier),
            localIdentifier: asset.localIdentifier,
            kind: kind,
            creationDate: asset.creationDate,
            duration: asset.duration,
            pixelWidth: asset.pixelWidth,
            pixelHeight: asset.pixelHeight,
            isFavorite: asset.isFavorite,
            hasEdits: asset.hasAdjustments,
            isLivePhoto: isLive,
            size: ByteEstimate(bytes: bytes, confidence: .estimated)
        )
    }

    // MARK: Exact measurement

    /// Counts the bytes of every resource of the asset that is stored on this iPhone, by streaming
    /// them through the documented `PHAssetResourceManager`. Network access is disabled, so this never
    /// downloads from iCloud; if an original isn't on the device the result says so.
    func measure(localIdentifier: String, computeHash: Bool = false) async -> (MeasureResult, String?) {
        guard let asset = assets(for: [localIdentifier]).first else { return (.failed("Item no longer exists."), nil) }
        let resources = PHAssetResource.assetResources(for: asset)
        guard !resources.isEmpty else { return (.failed("Photos returned no resources."), nil) }
        let accumulator = DataAccumulator(computeHash: computeHash)
        for resource in resources {
            if Task.isCancelled { return (.failed("Cancelled."), nil) }
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = false
            let error: Error? = await withCheckedContinuation { continuation in
                PHAssetResourceManager.default().requestData(for: resource, options: options, dataReceivedHandler: { data in
                    accumulator.add(data)
                }, completionHandler: { error in
                    continuation.resume(returning: error)
                })
            }
            if let error {
                // Network access is disabled, so a resource that exists only in iCloud fails with this code.
                if (error as? PHPhotosError)?.code == .networkAccessRequired {
                    return (.notOnDevice, nil)
                }
                return (.failed(error.localizedDescription), nil)
            }
        }
        return (.measured(accumulator.byteCount), accumulator.hash)
    }

    // MARK: Thumbnails and perceptual hashes

    func thumbnail(for localIdentifier: String, size: CGSize) async -> UIImage? {
        guard let asset = assets(for: [localIdentifier]).first else { return nil }
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let once = ResumeOnce()
        return await withCheckedContinuation { continuation in
            imageManager.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { image, info in
                let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                // Opportunistic delivery may call back twice: a quick low-quality image, then the final one.
                if (!degraded || image == nil) && once.claim() {
                    continuation.resume(returning: image)
                }
            }
        }
    }

    /// A tiny grayscale thumbnail reduced to a 64-bit difference hash. Uses the locally cached
    /// thumbnail only; never downloads.
    func perceptualHash(for asset: PHAsset) async -> PerceptualHash? {
        let options = PHImageRequestOptions()
        options.deliveryMode = .fastFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        options.isSynchronous = false
        let image: UIImage? = await withCheckedContinuation { continuation in
            imageManager.requestImage(for: asset, targetSize: CGSize(width: 64, height: 64), contentMode: .aspectFit, options: options) { image, _ in
                continuation.resume(returning: image)
            }
        }
        guard let cgImage = image?.cgImage else { return nil }
        return Self.hash(cgImage)
    }

    static func hash(_ image: CGImage) -> PerceptualHash? {
        let width = PerceptualHash.width
        let height = PerceptualHash.height
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? PerceptualHash(grayscale: pixels) : nil
    }

    // MARK: Video preview

    func playerItem(for localIdentifier: String) async -> AVPlayerItem? {
        guard let asset = assets(for: [localIdentifier]).first else { return nil }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        return await withCheckedContinuation { continuation in
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
                continuation.resume(returning: item)
            }
        }
    }

    // MARK: Deletion

    /// Deletes through PhotoKit. iOS shows its own confirmation alert as well; if the user
    /// declines it, nothing is deleted. Afterwards the IDs are re-fetched to confirm.
    func delete(localIdentifiers: [String]) async -> DeletionOutcome {
        let targets = assets(for: localIdentifiers)
        guard !targets.isEmpty else { return .cancelledOrFailed("The selected items no longer exist in your library.") }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.deleteAssets(targets as NSArray)
            }
        } catch {
            return .cancelledOrFailed(error.localizedDescription)
        }
        let remaining = assets(for: localIdentifiers).count
        let removed = targets.count - remaining
        return removed > 0 ? .deleted(count: removed) : .cancelledOrFailed("Photos reported success but the items are still present.")
    }

    // MARK: Limited library

    @MainActor
    static func presentLimitedLibraryPicker() async -> [String] {
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first else { return [] }
        var presenter = root
        while let presented = presenter.presentedViewController { presenter = presented }
        return await withCheckedContinuation { continuation in
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { identifiers in
                continuation.resume(returning: identifiers)
            }
        }
    }
}

/// Collects streamed bytes from PhotoKit callbacks, which may arrive on any queue.
private final class DataAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var hasher: StreamingSHA256?
    private var count: Int64 = 0

    init(computeHash: Bool) {
        hasher = computeHash ? StreamingSHA256() : nil
    }

    func add(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        count += Int64(data.count)
        hasher?.update(data)
    }

    var byteCount: Int64 {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    var hash: String? {
        lock.lock()
        defer { lock.unlock() }
        return hasher?.finalize()
    }
}

/// Guards a continuation against being resumed twice.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
