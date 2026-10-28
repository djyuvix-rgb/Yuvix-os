import Foundation

enum FileCategory: String, Codable, CaseIterable, Identifiable {
    case video, audio, image, archive, document, project, other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .video: return "Videos"
        case .audio: return "Audio"
        case .image: return "Images"
        case .archive: return "Archives"
        case .document: return "Documents"
        case .project: return "Creative projects"
        case .other: return "Other"
        }
    }

    var symbol: String {
        switch self {
        case .video: return "film"
        case .audio: return "waveform"
        case .image: return "photo"
        case .archive: return "archivebox"
        case .document: return "doc.text"
        case .project: return "music.note.list"
        case .other: return "doc"
        }
    }

    static let extensions: [FileCategory: Set<String>] = [
        .video: ["mov", "mp4", "m4v", "avi", "mkv", "webm", "3gp", "hevc", "mts"],
        .audio: ["wav", "aif", "aiff", "mp3", "m4a", "aac", "flac", "alac", "ogg", "opus", "caf", "wma"],
        .image: ["jpg", "jpeg", "png", "heic", "heif", "gif", "tif", "tiff", "dng", "raw", "cr2", "cr3", "nef", "arw", "webp", "bmp", "psd"],
        .archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "dmg", "ipa", "pkg"],
        .document: ["pdf", "doc", "docx", "pages", "txt", "rtf", "md", "xls", "xlsx", "numbers", "csv", "ppt", "pptx", "key", "epub"],
        .project: ValuableContentDetector.projectExtensions,
    ]

    static func classify(fileExtension ext: String) -> FileCategory {
        let lower = ext.lowercased()
        for category in [FileCategory.project, .video, .audio, .image, .archive, .document]
        where extensions[category]?.contains(lower) == true {
            return category
        }
        return .other
    }
}

/// Flags files that might be someone's creative work, so the app can warn before cleanup.
enum ValuableContentDetector {
    static let projectExtensions: Set<String> = [
        "als", "alp", "logicx", "band", "flp", "ptx", "ptf", "rpp", "aup3", "cpr", "song", "bwproject",
        "nki", "serato", "rekordbox", "prproj", "drp", "fcpbundle", "imovieproj", "lumafusion", "aep", "veg",
    ]

    static let keywords: [String] = [
        "mix", "master", "stem", "demo", "session", "bounce", "track", "beat", "vocal", "recording",
        "project", "draft", "original", "raw", "footage", "edit", "final", "set",
    ]

    /// Human-readable reasons a file may be valuable. Empty means no warning signs were found;
    /// it does not mean the file is safe to delete.
    static func reasons(fileName: String, category: FileCategory) -> [String] {
        var result: [String] = []
        switch category {
        case .project:
            result.append("Creative project file (music or video session)")
        case .audio:
            result.append("Audio file: could be a recording, mix or export")
        case .video:
            result.append("Video file: could be original footage or an edit")
        default:
            break
        }
        let words = tokenize(fileName)
        let matched = keywords.filter { words.contains($0) }
        if !matched.isEmpty {
            result.append("Name suggests creative work (\(matched.joined(separator: ", ")))")
        }
        return result
    }

    /// Reasons a photo-library item may be valuable, from public `PHAsset` properties.
    static func reasons(isFavorite: Bool, hasEdits: Bool, isScreenCapture: Bool, durationSeconds: Double) -> [String] {
        var result: [String] = []
        if isFavorite { result.append("Marked as a Favorite in Photos") }
        if hasEdits { result.append("Edited in Photos") }
        if !isScreenCapture && durationSeconds >= 5 * 60 {
            result.append("Long camera video: could be original footage")
        }
        return result
    }

    static func tokenize(_ name: String) -> Set<String> {
        let stem = (name as NSString).deletingPathExtension.lowercased()
        return Set(stem.split(whereSeparator: { !$0.isLetter }).map(String.init))
    }
}

/// Finds files that look like several exports or copies of the same thing,
/// such as "Mix.wav", "Mix (1).wav" and "Mix copy.wav" in one folder.
enum RedundantExportDetector {
    struct Input: Hashable {
        let id: String
        let fileName: String
        let directory: String
        let size: Int64
    }

    static func normalizedStem(_ fileName: String) -> String {
        var stem = (fileName as NSString).deletingPathExtension.lowercased()
        let patterns = [
            #"\s*\(\d+\)$"#,                       // "name (1)"
            #"\s+copy(\s+\d+)?$"#,                 // "name copy", "name copy 2"
            #"[\s_-]+(v|ver|version)\s*\d+$"#,     // "name v2", "name_version3"
            #"[\s_-]+(export(ed)?|final|bounce|render(ed)?)$"#, // "name_export", "name final"
            // Deliberately no bare trailing-number rule: "Track 1" and "Track 2" are different songs.
        ]
        var changed = true
        while changed {
            changed = false
            for pattern in patterns {
                if let range = stem.range(of: pattern, options: .regularExpression) {
                    stem.removeSubrange(range)
                    changed = true
                }
            }
        }
        return stem.trimmingCharacters(in: .whitespaces)
    }

    /// Groups of two or more files in the same folder with the same extension and normalized name.
    static func groups(_ inputs: [Input]) -> [[Input]] {
        let grouped = Dictionary(grouping: inputs) { input -> String in
            let ext = (input.fileName as NSString).pathExtension.lowercased()
            return "\(input.directory)|\(normalizedStem(input.fileName))|\(ext)"
        }
        return grouped.values
            .filter { $0.count > 1 && !normalizedStem($0[0].fileName).isEmpty }
            .map { $0.sorted { $0.fileName < $1.fileName } }
            .sorted { DuplicateFinder.conservativeSavings(memberSizes: $0.map(\.size)) > DuplicateFinder.conservativeSavings(memberSizes: $1.map(\.size)) }
    }
}
