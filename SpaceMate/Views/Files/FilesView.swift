import SwiftUI
import UniformTypeIdentifiers

enum FileRoute: Hashable {
    case all
    case category(FileCategory)
    case downloads
    case duplicates
    case redundant
    case largeFiles
    case issues
    case file(String)
}

extension View {
    func fileDestinations() -> some View {
        navigationDestination(for: FileRoute.self) { route in
            switch route {
            case .all: FileListView(title: "All Files", filter: .all)
            case .category(let category): FileListView(title: category.title, filter: .category(category))
            case .downloads: FileListView(title: "Downloads", filter: .downloads)
            case .largeFiles: FileListView(title: "Large Files", filter: .large)
            case .duplicates: DuplicateGroupsView()
            case .redundant: RedundantGroupsView()
            case .issues: ScanIssuesView()
            case .file(let id): FileDetailView(fileID: id)
            }
        }
    }
}

struct FilesView: View {
    @Environment(AppModel.self) private var app
    @Environment(FilesModel.self) private var files
    @State private var pickingFolder = false
    @State private var pickingFiles = false
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Pick folders or files in the Files app (On My iPhone, iCloud Drive, Downloads and so on). SpaceMate can only see what you pick, and access ends when the app closes.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    HStack {
                        Button { pickingFolder = true } label: { Label("Scan a Folder", systemImage: "folder.badge.plus") }
                            .buttonStyle(.borderedProminent)
                        Button { pickingFiles = true } label: { Label("Add Files", systemImage: "doc.badge.plus") }
                            .buttonStyle(.bordered)
                    }
                }

                if let error = files.errorMessage {
                    Section { NoticeBox(style: .warning, title: "Scan problem", message: error) }
                }

                if files.isScanning || files.isHashing {
                    Section {
                        if files.isScanning {
                            ProgressView("Scanning…")
                        } else {
                            ProgressView(value: files.hashProgress) { Text("Checking for identical files…") }
                        }
                        Button("Stop", role: .cancel) { files.cancelScan() }
                    }
                }

                if files.hasScanned {
                    Section("Picked locations") {
                        ForEach(files.roots, id: \.self) { url in
                            Label(url.lastPathComponent, systemImage: "folder")
                        }
                        LabeledContent("Files found", value: "\(files.files.count)")
                        LabeledContent("Space on this iPhone") { SizeText(estimate: files.totalBytes) }
                    }

                    Section("Cleanup opportunities") {
                        routeRow(.duplicates, title: "Identical duplicates", symbol: "doc.on.doc",
                                 detail: "\(files.duplicateGroups.count) groups",
                                 bytes: files.duplicateGroups.reduce(0) { $0 + $1.reclaimableBytes })
                        routeRow(.redundant, title: "Possible repeated exports", symbol: "square.stack.3d.up",
                                 detail: "\(files.redundantGroups.count) groups", bytes: nil)
                        routeRow(.downloads, title: "In Downloads folders", symbol: "arrow.down.circle",
                                 detail: "\(files.downloads.count) files",
                                 bytes: files.downloads.reduce(0) { $0 + $1.localBytes })
                        routeRow(.largeFiles, title: "Large files", symbol: "externaldrive",
                                 detail: "Over \(ByteFormat.string(app.settings.largeFileThreshold))", bytes: nil)
                    }

                    Section("By type") {
                        ForEach(files.byCategory()) { group in
                            routeRow(.category(group.category), title: group.category.title, symbol: group.category.symbol,
                                     detail: "\(group.files.count) files", bytes: group.files.reduce(0) { $0 + $1.localBytes })
                        }
                        NavigationLink(value: FileRoute.all) { Label("All files", systemImage: "list.bullet") }
                    }

                    if !files.issues.isEmpty {
                        Section {
                            NavigationLink(value: FileRoute.issues) {
                                Label("\(files.issues.count) items couldn't be read", systemImage: "exclamationmark.triangle")
                            }
                        }
                    }

                    Section {
                        Button("Rescan") { files.scan() }
                        Button("Forget Picked Locations", role: .destructive) { confirmClear = true }
                    } footer: {
                        Text("Forgetting only removes them from SpaceMate. Nothing is deleted.")
                    }
                }
            }
            .navigationTitle("Files")
            .fileDestinations()
            .fileImporter(isPresented: $pickingFolder, allowedContentTypes: [.folder], allowsMultipleSelection: true) { handle($0) }
            .background {
                // A second importer needs its own view to coexist with the first.
                Color.clear.fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { handle($0) }
            }
            .confirmationDialog("Forget picked locations?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Forget", role: .destructive) { files.reset() }
            }
        }
    }

    private func handle(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard !urls.isEmpty else { return }
            files.add(urls)
            app.markFilesScanned()
        case .failure(let error):
            files.errorMessage = error.localizedDescription
        }
    }

    private func routeRow(_ route: FileRoute, title: String, symbol: String, detail: String, bytes: Int64?) -> some View {
        NavigationLink(value: route) {
            HStack {
                Label(title, systemImage: symbol)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(detail).font(.subheadline).foregroundStyle(.secondary)
                    if let bytes, bytes > 0 { Text(ByteFormat.string(bytes)).font(.caption).monospacedDigit().foregroundStyle(.secondary) }
                }
            }
        }
    }
}

struct ScanIssuesView: View {
    @Environment(FilesModel.self) private var files

    var body: some View {
        List(files.issues) { issue in
            VStack(alignment: .leading) {
                Text((issue.path as NSString).lastPathComponent).font(.subheadline)
                Text(issue.message).font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Unreadable Items")
    }
}
