import SwiftUI

struct FileDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(FilesModel.self) private var files
    let fileID: String
    @State private var previewing = false
    @State private var exporting = false
    @State private var exportMessage: String?
    @State private var review: ReviewSelection?

    var body: some View {
        if let file = files.file(id: fileID) {
            List {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: file.category.symbol).font(.largeTitle).foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading) {
                            Text(file.name).font(.headline)
                            Text(file.category.title).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    Button { previewing = true } label: { Label("Preview", systemImage: "eye") }
                        .disabled(!file.isDownloaded)
                }

                Section("Details") {
                    LabeledContent("Location") { Text(file.displayPath).multilineTextAlignment(.trailing).font(.footnote) }
                    LabeledContent("Space on this iPhone") { SizeText(estimate: file.sizeEstimate) }
                    if file.size != file.localBytes {
                        LabeledContent("File size", value: ByteFormat.string(file.size))
                    }
                    if let modified = file.modified {
                        LabeledContent("Modified", value: modified.formatted(date: .long, time: .shortened))
                    }
                    if file.isCloudItem {
                        LabeledContent("Cloud", value: file.isDownloaded ? "Synced, downloaded" : "In the cloud only")
                    }
                    if let hash = file.sha256 {
                        LabeledContent("SHA-256") { Text(String(hash.prefix(16)) + "…").font(.caption.monospaced()) }
                    }
                }

                if file.isCloudItem {
                    Section {
                        NoticeBox(style: .warning, title: "Synced cloud file",
                                  message: file.isDownloaded
                                  ? "Deleting it removes it from the cloud and every device using this folder. A synced file is not an independent backup."
                                  : "This file isn't downloaded, so it uses almost no space on this iPhone. Deleting it would remove it from the cloud and gain nothing here.")
                    }
                }

                if !file.valuableReasons.isEmpty {
                    Section {
                        NoticeBox(style: .warning, title: "Protect before cleaning?", message: file.valuableReasons.joined(separator: "\n"))
                    }
                }

                Section {
                    Toggle(isOn: Binding(get: { app.isProtected(file.id) }, set: { _ in app.toggleProtection(file: file) })) {
                        Label("Protect this file", systemImage: "lock.shield")
                    }
                    if let item = app.protectedItem(id: file.id) {
                        BackupStatusPicker(item: item)
                    }
                    Button { exporting = true } label: { Label("Export a Copy…", systemImage: "square.and.arrow.up.on.square") }
                        .disabled(!file.isDownloaded)
                    ShareLink(item: file.url) { Label("Share…", systemImage: "square.and.arrow.up") }
                    if let exportMessage {
                        Text(exportMessage).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Keep it safe")
                } footer: {
                    Text("“Export a Copy” saves a copy to a location you choose and checks the copy's contents match. Protected files are never suggested for cleanup.")
                }

                if !app.isProtected(file.id) {
                    Section {
                        Button(role: .destructive) { review = ReviewSelection(ids: [file.id]) } label: {
                            Label("Review & Delete…", systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $previewing) { QuickLookPreview(url: file.url).ignoresSafeArea() }
            .sheet(isPresented: $exporting) {
                DocumentExporter(url: file.url) { destinations in
                    exporting = false
                    handleExport(file: file, destinations: destinations)
                }
            }
            .sheet(item: $review) { FileDeleteReviewView(fileIDs: $0.ids) }
        } else {
            ContentUnavailableView("File not available", systemImage: "doc", description: Text("It may have been deleted or moved."))
        }
    }

    /// Hashes the exported copy and the original. Only a match counts as a verified backup.
    private func handleExport(file: ScannedFile, destinations: [URL]) {
        guard let destination = destinations.first else {
            exportMessage = "Export cancelled."
            return
        }
        exportMessage = "Checking the exported copy…"
        Task {
            let accessing = destination.startAccessingSecurityScopedResource()
            let source = file.url
            let verified = await Task.detached { FileOperations.verifyCopy(original: source, copy: destination) }.value
            if accessing { destination.stopAccessingSecurityScopedResource() }
            if !app.isProtected(file.id) { app.toggleProtection(file: file) }
            app.setBackupStatus(verified ? .verified : .exportedUnverified, for: file.id)
            exportMessage = verified
                ? "Copy saved to “\(destination.deletingLastPathComponent().lastPathComponent)” and verified: contents match. The file is now protected."
                : "Copy saved, but SpaceMate couldn't read it back to verify it. Treat it as unverified. The file is now protected."
        }
    }
}

/// Shows exactly which files will be permanently deleted, with sync warnings, and reports real results.
struct FileDeleteReviewView: View {
    @Environment(AppModel.self) private var app
    @Environment(FilesModel.self) private var files
    @Environment(\.dismiss) private var dismiss
    let fileIDs: [String]
    @State private var acknowledged = false
    @State private var isDeleting = false
    @State private var report: FileDeletionReport?

    private var all: [ScannedFile] { files.files(withIDs: fileIDs) }
    private var targets: [ScannedFile] { all.filter { !app.isProtected($0.id) } }

    var body: some View {
        NavigationStack {
            Group {
                if let report { result(report) } else { reviewList }
            }
            .navigationTitle(report == nil ? "Review Deletion" : "Result")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: report == nil ? .cancellationAction : .confirmationAction) {
                    Button(report == nil ? "Cancel" : "Done") { dismiss() }.disabled(isDeleting)
                }
            }
        }
        .interactiveDismissDisabled(isDeleting)
    }

    private var reviewList: some View {
        let cloud = targets.filter(\.isCloudItem)
        let valuable = targets.filter { !$0.valuableReasons.isEmpty }
        return List {
            Section {
                LabeledContent("Files") { Text("\(targets.count)").monospacedDigit() }
                LabeledContent("Space on this iPhone") { SizeText(estimate: targets.map(\.sizeEstimate).total()) }
                if all.count > targets.count {
                    Text("\(all.count - targets.count) protected file(s) excluded.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                NoticeBox(style: .danger, title: "Permanent",
                          message: "Files deleted by SpaceMate don't go to a Recently Deleted folder and can't be restored unless you have another copy.")
                if !cloud.isEmpty {
                    NoticeBox(style: .warning, title: "\(cloud.count) synced cloud file\(cloud.count == 1 ? "" : "s")",
                              message: "Deleting removes them from the cloud and every device that uses the folder, not just this iPhone.")
                }
                if !valuable.isEmpty {
                    NoticeBox(style: .warning, title: "Protect before cleaning",
                              message: "\(valuable.count) file\(valuable.count == 1 ? " looks" : "s look") like creative work (recordings, mixes, footage or projects). Export a copy first if you're not certain.")
                }
            }
            Section("Files to delete") {
                ForEach(targets) { file in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.name).font(.subheadline)
                        Text(file.displayPath).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        Text(ByteFormat.string(file.localBytes)).font(.caption).monospacedDigit()
                    }
                }
            }
            Section {
                Toggle("I understand this is permanent", isOn: $acknowledged)
                Button(role: .destructive) {
                    Task {
                        isDeleting = true
                        report = await files.delete(ids: targets.map(\.id), app: app)
                        isDeleting = false
                    }
                } label: {
                    HStack {
                        Spacer()
                        if isDeleting { ProgressView() } else { Text("Delete \(targets.count) File\(targets.count == 1 ? "" : "s")").bold() }
                        Spacer()
                    }
                }
                .disabled(!acknowledged || targets.isEmpty || isDeleting)
            }
        }
    }

    private func result(_ report: FileDeletionReport) -> some View {
        List {
            Section {
                if report.deleted.isEmpty {
                    Label("Nothing was deleted", systemImage: "xmark.circle").foregroundStyle(.secondary)
                } else {
                    Label("Deleted \(report.deleted.count) file\(report.deleted.count == 1 ? "" : "s")", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    LabeledContent("Size of deleted files") { SizeText(estimate: report.estimated) }
                    LabeledContent("Measured change in free space") {
                        Text(report.measuredChange.map { $0 >= 0 ? "+\(ByteFormat.string($0))" : "−\(ByteFormat.string(-$0))" } ?? "Not available")
                            .monospacedDigit()
                    }
                }
            } footer: {
                Text("The measured change comes from iOS and includes any other activity on your phone. Files in cloud folders may free less space here if they were partly offloaded.")
            }
            if !report.failures.isEmpty {
                Section("Not deleted") {
                    ForEach(Array(report.failures.enumerated()), id: \.offset) { _, failure in
                        VStack(alignment: .leading) {
                            Text(failure.name).font(.subheadline)
                            Text(failure.reason).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}
