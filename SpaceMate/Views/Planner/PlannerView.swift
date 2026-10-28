import SwiftUI

struct PlannerView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    @Environment(FilesModel.self) private var files

    var body: some View {
        let recommendations = app.recommendations
        NavigationStack {
            List {
                Section {
                    summary(recommendations)
                }
                ForEach(RecommendationTier.allCases) { tier in
                    let list = recommendations.filter { $0.tier == tier }
                    if !list.isEmpty {
                        Section {
                            ForEach(list) { RecommendationCard(recommendation: $0) }
                        } header: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tier.title)
                                Text(tier.subtitle).font(.caption).textCase(nil)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Cleanup Plan")
            .mediaDestinations()
            .fileDestinations()
            .navigationDestination(for: SettingsGuide.self) { GuideDetailView(guide: $0) }
        }
    }

    @ViewBuilder private func summary(_ list: [Recommendation]) -> some View {
        let total = RecommendationEngine.totalEstimate(list)
        VStack(alignment: .leading, spacing: 8) {
            if total.bytes > 0 {
                Text("Potential savings").font(.subheadline).foregroundStyle(.secondary)
                SizeText(estimate: total).font(.title2.bold())
                Text("Combined from what SpaceMate analyzed. Protected items are excluded. Nothing is deleted until you review and confirm.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("No analyzed cleanup candidates yet").font(.headline)
                Text("Analyze Photos and scan folders in Files to get personalised suggestions. The guided steps below work any time.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if app.bytesNeededForTarget > 0 {
                Label("You need about \(ByteFormat.string(app.bytesNeededForTarget)) more to reach your free-space target.", systemImage: "target")
                    .font(.footnote).foregroundStyle(.orange)
            }
            if !media.hasAnalyzed || !files.hasScanned {
                HStack {
                    if !media.hasAnalyzed { Button("Analyze Photos") { app.selectedTab = .media } }
                    if !files.hasScanned { Button("Scan Files") { app.selectedTab = .files } }
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
}

struct RecommendationCard: View {
    @Environment(AppModel.self) private var app
    let recommendation: Recommendation
    @State private var expanded = false

    var body: some View {
        let rec = recommendation
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: rec.symbol).font(.title3).frame(width: 30).foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(rec.title).font(.headline).foregroundStyle(.primary)
                        if let estimate = rec.estimate {
                            SizeText(estimate: estimate, prefix: "Up to ").font(.subheadline)
                            Text("\(rec.itemCount) item\(rec.itemCount == 1 ? "" : "s") · \(rec.risk.label)")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("Size known only to iOS · \(rec.risk.label)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint(expanded ? "Collapse details" : "Expand details")

            if expanded {
                detail("Why", rec.why)
                detail("How the size was calculated", rec.estimateMethod)
                detail("Can it be undone?", rec.reversibility.label)
                if let cloud = rec.cloudNote { detail("iCloud and sync", cloud) }
                if rec.hasValuableSigns {
                    detail("Protect before cleaning", "Some items look like personal or creative work. Review each one and protect anything you want to keep.")
                }
                if rec.protectedItemsExcluded > 0 {
                    detail("Protected", "\(rec.protectedItemsExcluded) protected item(s) are excluded from this estimate.")
                }
                detail("How to do it", rec.howTo)
                actionLink
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var actionLink: some View {
        let label = Text(actionTitle).font(.subheadline.weight(.semibold))
        switch recommendation.destination {
        case .media(let kind):
            NavigationLink(value: kind == .similarPhotos ? MediaRoute.similarGroups : MediaRoute.list(kind)) { label }
        case .files(let kind):
            NavigationLink(value: fileRoute(for: kind)) { label }
        case .guide(let id):
            if let guide = SettingsGuide.guide(id: id) {
                NavigationLink(value: guide) { label }
            }
        case .routine:
            Button { app.selectedTab = .routine } label: { label }
        }
    }

    private func fileRoute(for kind: CandidateKind) -> FileRoute {
        switch kind {
        case .duplicateFiles: return .duplicates
        case .redundantExports: return .redundant
        case .largeDownloads: return .downloads
        default: return .largeFiles
        }
    }

    private var actionTitle: String {
        switch recommendation.destination {
        case .guide: return "Show me how"
        case .routine: return "Set up routine"
        default: return "Review items"
        }
    }

    private func detail(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(text).font(.footnote).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct GuideDetailView: View {
    let guide: SettingsGuide

    var body: some View {
        List {
            Section {
                Text(guide.summary).font(.subheadline)
            }
            Section("Steps") {
                ForEach(Array(guide.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)")
                            .font(.caption.bold())
                            .frame(width: 22, height: 22)
                            .background(Color.accentColor.opacity(0.15), in: Circle())
                        Text(step)
                    }
                }
            }
            Section("Tips") {
                ForEach(guide.details, id: \.self) { Text($0).font(.subheadline) }
            }
            Section("What you may lose") {
                Text(guide.whatYouMayLose).font(.subheadline)
                Text(guide.reversibility.label).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Button {
                    SystemSettings.openAppSettings()
                } label: {
                    Label("Open Settings", systemImage: "gear")
                }
            } footer: {
                Text("Apple doesn't let apps link directly to iPhone Storage. This opens SpaceMate's page in Settings. Tap “Settings” at the top left to get back to the main list, then follow the steps above. No app can promise how much space these steps will free.")
            }
        }
        .navigationTitle(guide.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct GuidesListView: View {
    var body: some View {
        List(SettingsGuide.all) { guide in
            NavigationLink(value: guide) {
                Label(guide.title, systemImage: guide.symbol)
            }
        }
        .navigationTitle("iPhone Storage Guides")
    }
}
