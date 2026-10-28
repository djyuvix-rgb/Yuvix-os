import SwiftUI

/// Shows exactly what will be deleted and what it means, then deletes only on an explicit tap.
struct MediaDeleteReviewView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    @Environment(\.dismiss) private var dismiss
    let itemIDs: [String]
    @State private var acknowledged = false
    @State private var isDeleting = false
    @State private var report: MediaDeletionReport?

    var body: some View {
        NavigationStack {
            Group {
                if let report {
                    resultView(report)
                } else {
                    reviewList
                }
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

    private var allItems: [MediaItem] { media.items(itemIDs) }
    private var targets: [MediaItem] { allItems.filter { !app.isProtected($0.id) } }
    private var excludedCount: Int { allItems.count - targets.count }
    private var valuable: [MediaItem] { targets.filter { !$0.valuableReasons.isEmpty } }

    private var reviewList: some View {
        List {
            Section {
                LabeledContent("Items") { Text("\(targets.count)").monospacedDigit() }
                LabeledContent("Estimated size") { SizeText(estimate: targets.map(\.size).total()) }
                if excludedCount > 0 {
                    Text("\(excludedCount) protected item\(excludedCount == 1 ? " is" : "s are") excluded and won't be deleted.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }

            Section {
                NoticeBox(style: .warning, title: "Affects iCloud Photos",
                          message: "If iCloud Photos is on, these items are also deleted from iCloud and all your devices signed in to the same Apple Account.")
                NoticeBox(style: .info, title: "Recently Deleted",
                          message: "Photos keeps deleted items in Recently Deleted for about 30 days. The space is only freed after that, or when you empty Recently Deleted yourself in the Photos app. SpaceMate never empties it.")
                if !valuable.isEmpty {
                    NoticeBox(style: .danger, title: "\(valuable.count) item\(valuable.count == 1 ? " looks" : "s look") potentially valuable",
                              message: "Favorites, edited items or long camera videos are included. Make sure you really want to remove them, or protect them first.")
                }
                if targets.contains(where: { $0.size.confidence == .estimated }) {
                    Text("Sizes marked Estimated are calculated from resolution and duration. The real space freed may differ.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Items to delete") {
                ForEach(targets) { item in
                    HStack(spacing: 12) {
                        AssetThumbnail(localIdentifier: item.localIdentifier, service: media.service, side: 48)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown date").font(.subheadline)
                            if !item.valuableReasons.isEmpty {
                                Text(item.valuableReasons.joined(separator: " · ")).font(.caption2).foregroundStyle(.orange)
                            }
                        }
                        Spacer()
                        SizeText(estimate: item.size).font(.caption)
                    }
                }
            }

            Section {
                Toggle("I've reviewed these items", isOn: $acknowledged)
                Button(role: .destructive) {
                    Task { await performDelete() }
                } label: {
                    HStack {
                        Spacer()
                        if isDeleting { ProgressView() } else { Text("Delete \(targets.count) Item\(targets.count == 1 ? "" : "s")").bold() }
                        Spacer()
                    }
                }
                .disabled(!acknowledged || targets.isEmpty || isDeleting)
            } footer: {
                Text("iOS will also ask you to confirm.")
            }
        }
    }

    private func performDelete() async {
        isDeleting = true
        report = await media.delete(ids: targets.map(\.id), app: app)
        isDeleting = false
    }

    private func resultView(_ report: MediaDeletionReport) -> some View {
        List {
            if report.deleted > 0 {
                Section {
                    Label("\(report.deleted) of \(report.requested) item\(report.requested == 1 ? "" : "s") moved to Recently Deleted", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    LabeledContent("Estimated size removed") { SizeText(estimate: report.estimated) }
                    LabeledContent("Measured change in free space") {
                        Text(report.measuredChange.map(signed) ?? "Not available").monospacedDigit()
                    }
                } footer: {
                    Text("Little or no measured change is expected right now: Photos holds deleted items in Recently Deleted for about 30 days. To free the space sooner, open Photos → Albums → Recently Deleted. Other activity on your phone also affects this measurement.")
                }
            } else {
                Section {
                    Label("Nothing was deleted", systemImage: "xmark.circle").foregroundStyle(.secondary)
                    if let message = report.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
            }
        }
    }

    private func signed(_ bytes: Int64) -> String {
        bytes >= 0 ? "+\(ByteFormat.string(bytes))" : "−\(ByteFormat.string(-bytes))"
    }
}
