import SwiftUI

enum FileFilter: Hashable {
    case all, downloads, large
    case category(FileCategory)
    case ids([String])
}

struct FileListView: View {
    @Environment(AppModel.self) private var app
    @Environment(FilesModel.self) private var files
    let title: String
    let filter: FileFilter
    @State private var sort: FileSort = .size
    @State private var groupByType = false
    @State private var review: ReviewSelection?

    private var source: [ScannedFile] {
        switch filter {
        case .all: return files.files
        case .downloads: return files.downloads
        case .large: return files.files.filter { $0.localBytes >= app.settings.largeFileThreshold }
        case .category(let category): return files.files.filter { $0.category == category }
        case .ids(let ids): return files.files(withIDs: ids)
        }
    }

    private var selectedHere: [ScannedFile] { source.filter { files.selectedIDs.contains($0.id) } }

    var body: some View {
        let sorted = FilesModel.sorted(source, by: sort)
        List {
            Section {
                Picker("Sort", selection: $sort) {
                    ForEach(FileSort.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                if filter == .all || filter == .downloads || filter == .large {
                    Toggle("Group by type", isOn: $groupByType)
                }
            }
            if sorted.isEmpty {
                ContentUnavailableView("No files", systemImage: "doc")
            } else if groupByType {
                ForEach(FileCategory.allCases) { category in
                    let list = sorted.filter { $0.category == category }
                    if !list.isEmpty {
                        Section(category.title) { ForEach(list) { FileRow(file: $0) } }
                    }
                }
            } else {
                Section { ForEach(sorted) { FileRow(file: $0) } }
            }
        }
        .navigationTitle(title)
        .toolbar {
            Menu {
                Button("Deselect All") { files.deselect(ids: source.map(\.id)) }
            } label: { Image(systemName: "checklist") }
            .accessibilityLabel("Selection options")
        }
        .safeAreaInset(edge: .bottom) {
            if !selectedHere.isEmpty {
                FileSelectionBar(files: selectedHere) { review = ReviewSelection(ids: selectedHere.map(\.id)) }
            }
        }
        .sheet(item: $review) { FileDeleteReviewView(fileIDs: $0.ids) }
    }
}

struct FileRow: View {
    @Environment(AppModel.self) private var app
    @Environment(FilesModel.self) private var files
    let file: ScannedFile
    var showsPath = true

    var body: some View {
        let isProtected = app.isProtected(file.id)
        HStack(spacing: 12) {
            Button { files.toggleSelection(file.id) } label: {
                SelectionMark(isSelected: files.selectedIDs.contains(file.id))
            }
            .buttonStyle(.borderless)
            .disabled(isProtected)
            .accessibilityLabel(files.selectedIDs.contains(file.id) ? "Deselect" : "Select")

            NavigationLink(value: FileRoute.file(file.id)) {
                HStack(spacing: 10) {
                    Image(systemName: file.category.symbol).frame(width: 24).foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(file.name).font(.subheadline.weight(.medium)).lineLimit(1)
                            if isProtected { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                            if !isProtected && !file.valuableReasons.isEmpty {
                                Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow).accessibilityLabel("May be valuable")
                            }
                        }
                        if showsPath {
                            Text((file.displayPath as NSString).deletingLastPathComponent).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        HStack(spacing: 6) {
                            Text(ByteFormat.string(file.localBytes)).font(.caption).monospacedDigit()
                            if let modified = file.modified {
                                Text(modified.formatted(date: .abbreviated, time: .omitted)).font(.caption).foregroundStyle(.secondary)
                            }
                            if file.isCloudItem {
                                Image(systemName: file.isDownloaded ? "icloud.fill" : "icloud.and.arrow.down")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .accessibilityLabel(file.isDownloaded ? "Cloud file, downloaded" : "Cloud file, not downloaded")
                            }
                        }
                    }
                }
            }
        }
    }
}

struct FileSelectionBar: View {
    let files: [ScannedFile]
    let onReview: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text("\(files.count) selected").font(.subheadline.weight(.semibold))
                SizeText(estimate: files.map(\.sizeEstimate).total(), prefix: "Potential savings ").font(.caption)
            }
            Spacer()
            Button("Review", action: onReview).buttonStyle(.borderedProminent)
        }
        .padding()
        .background(.bar)
    }
}

struct DuplicateGroupsView: View {
    @Environment(FilesModel.self) private var files
    @State private var review: ReviewSelection?

    var body: some View {
        List {
            Section {
                Text("Files in each group have identical contents (matching SHA-256). Choose which copies to delete. Keep at least one. Cloud files that aren't downloaded are skipped so nothing gets downloaded.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if files.duplicateGroups.isEmpty {
                ContentUnavailableView("No identical files found", systemImage: "doc.on.doc")
            }
            ForEach(files.duplicateGroups) { group in
                let members = files.files(withIDs: group.memberIDs)
                Section {
                    ForEach(members) { FileRow(file: $0) }
                    if members.allSatisfy({ files.selectedIDs.contains($0.id) }) {
                        NoticeBox(style: .warning, title: "All copies selected", message: "Deleting all of them keeps no copy.")
                    }
                } header: {
                    Text("\(members.count) copies · \(ByteFormat.string(group.bytesPerCopy)) each · save \(ByteFormat.string(group.reclaimableBytes))")
                }
            }
        }
        .navigationTitle("Identical Files")
        .safeAreaInset(edge: .bottom) {
            let selected = files.selectedFiles.filter { file in files.duplicateGroups.contains { $0.memberIDs.contains(file.id) } }
            if !selected.isEmpty {
                FileSelectionBar(files: selected) { review = ReviewSelection(ids: selected.map(\.id)) }
            }
        }
        .sheet(item: $review) { FileDeleteReviewView(fileIDs: $0.ids) }
    }
}

struct RedundantGroupsView: View {
    @Environment(FilesModel.self) private var files
    @State private var review: ReviewSelection?

    var body: some View {
        List {
            Section {
                Text("These files share a name apart from suffixes like “(1)”, “copy”, “v2” or “final”. They might be repeated exports, or different versions you need. Preview them before deciding.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if files.redundantGroups.isEmpty {
                ContentUnavailableView("No repeated exports found", systemImage: "square.stack.3d.up")
            }
            ForEach(Array(files.redundantGroups.enumerated()), id: \.offset) { _, group in
                Section((group.first?.directory ?? "")) {
                    ForEach(group) { FileRow(file: $0, showsPath: false) }
                }
            }
        }
        .navigationTitle("Repeated Exports")
        .safeAreaInset(edge: .bottom) {
            let ids = Set(files.redundantGroups.flatMap { $0.map(\.id) })
            let selected = files.selectedFiles.filter { ids.contains($0.id) }
            if !selected.isEmpty {
                FileSelectionBar(files: selected) { review = ReviewSelection(ids: selected.map(\.id)) }
            }
        }
        .sheet(item: $review) { FileDeleteReviewView(fileIDs: $0.ids) }
    }
}
