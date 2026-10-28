import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    @Environment(FilesModel.self) private var files
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    storageCard
                    targetCard
                    Button {
                        app.selectedTab = .plan
                    } label: {
                        Label("Free Up Space", systemImage: "sparkles")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    analysisCard
                    opportunitiesCard
                    limitsCard
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("SpaceMate")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { app.refreshStorage() } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh storage")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings and privacy")
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .refreshable { app.refreshStorage() }
            .navigationDestination(for: SettingsGuide.self) { GuideDetailView(guide: $0) }
        }
    }

    // MARK: Device storage

    @ViewBuilder private var storageCard: some View {
        Card {
            HStack {
                Text("iPhone storage").font(.headline)
                Spacer()
                ConfidenceBadge(confidence: .measured)
            }
            if let snapshot = app.snapshot {
                HStack(spacing: 20) {
                    StorageRing(fraction: snapshot.usedFraction)
                        .frame(width: 130, height: 130)
                    VStack(alignment: .leading, spacing: 10) {
                        LabeledFigure(title: "Available", value: ByteFormat.string(snapshot.available))
                        LabeledFigure(title: "Used", value: ByteFormat.string(snapshot.used))
                        LabeledFigure(title: "Capacity", value: ByteFormat.string(snapshot.totalCapacity))
                    }
                }
                if let purgeable = snapshot.purgeableEstimate, purgeable > 0 {
                    Text("Includes about \(ByteFormat.string(purgeable)) that iOS can free on its own when needed (caches and other purgeable data).")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Text("Measured by iOS \(snapshot.date.relativeDescription). Capacity is the formatted file-system size, so it's lower than the advertised size.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let error = app.storageError {
                NoticeBox(style: .warning, title: "Couldn't read storage", message: error)
            } else {
                ProgressView()
            }
        }
    }

    @ViewBuilder private var targetCard: some View {
        if let snapshot = app.snapshot {
            let target = app.settings.freeSpaceTarget
            let needed = app.bytesNeededForTarget
            Card {
                HStack {
                    Image(systemName: needed == 0 ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(needed == 0 ? Color.green : Color.orange)
                        .font(.title2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(needed == 0 ? "Free-space target met" : "Below your free-space target")
                            .font(.headline)
                        Text(needed == 0
                             ? "\(ByteFormat.string(snapshot.available - target)) above your \(ByteFormat.string(target)) target."
                             : "Free about \(ByteFormat.string(needed)) more to reach \(ByteFormat.string(target)).")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Change") { app.selectedTab = .routine }.font(.subheadline)
                }
            }
        }
    }

    // MARK: Analysis

    @ViewBuilder private var analysisCard: some View {
        Card {
            Text("What SpaceMate has analyzed").font(.headline)
            HStack(alignment: .top) {
                LabeledFigure(
                    title: "Photos & videos",
                    value: media.hasAnalyzed ? "\(media.analyzedCount) items" : "Not analyzed",
                    caption: media.hasAnalyzed ? "≈ \(media.analyzedBytes.formatted) (estimated)" : media.access.title
                )
                LabeledFigure(
                    title: "Files you picked",
                    value: files.hasScanned ? "\(files.files.count) files" : "None yet",
                    caption: files.hasScanned ? "\(files.totalBytes.formatted) (inspected)" : "Pick folders in Files"
                )
            }
            Divider()
            HStack(alignment: .top) {
                LabeledFigure(title: "Cleanup candidates", value: app.candidateTotal.bytes > 0 ? app.candidateTotal.formatted : "—",
                              caption: app.candidateTotal.bytes > 0 ? app.candidateTotal.confidence.label : "Analyze photos or files")
                LabeledFigure(title: "Selected for review", value: app.selectedTotal.bytes > 0 ? app.selectedTotal.formatted : "—",
                              caption: app.selectedTotal.bytes > 0 ? app.selectedTotal.confidence.label : "Nothing selected")
            }
            if let last = app.data.lastMediaAnalysis ?? app.data.lastFileScan {
                Text("Last analysis \(last.relativeDescription). Analysis results are kept only while the app is open.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var opportunitiesCard: some View {
        let top = app.recommendations.filter { $0.estimate != nil }.prefix(3)
        Card {
            HStack {
                Text("Best opportunities").font(.headline)
                Spacer()
                Button("See plan") { app.selectedTab = .plan }.font(.subheadline)
            }
            if top.isEmpty {
                Text("Analyze your photos or scan some folders to find cleanup opportunities.")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack {
                    Button("Analyze Photos") { app.selectedTab = .media }
                    Button("Scan Files") { app.selectedTab = .files }
                }
                .buttonStyle(.bordered)
            } else {
                ForEach(Array(top)) { rec in
                    HStack {
                        Image(systemName: rec.symbol).frame(width: 28).foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading) {
                            Text(rec.title).font(.subheadline.weight(.medium))
                            Text("\(rec.itemCount) item\(rec.itemCount == 1 ? "" : "s") · \(rec.risk.label)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let estimate = rec.estimate { SizeText(estimate: estimate).font(.subheadline) }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder private var limitsCard: some View {
        Card {
            Label("What iOS doesn't let apps see", systemImage: "lock.shield").font(.headline)
            Text("Apps can't measure other apps, Messages, System Data or caches. For a full breakdown by app, use iPhone Storage in Settings.")
                .font(.subheadline).foregroundStyle(.secondary)
            if let guide = SettingsGuide.guide(id: "iphone-storage") {
                NavigationLink(value: guide) {
                    Label("How to open iPhone Storage", systemImage: "arrow.right.circle")
                }
            }
        }
    }
}
