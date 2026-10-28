import SwiftUI

struct MediaListView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    let kind: CandidateKind
    @State private var sort: MediaSort = .size
    @State private var reviewIDs: ReviewSelection?

    private var source: [MediaItem] {
        switch kind {
        case .largeVideos: return media.videos.filter { $0.kind == .video }
        case .screenRecordings: return media.screenRecordings
        case .screenshots: return media.screenshots
        default: return []
        }
    }

    private var items: [MediaItem] { MediaModel.sorted(source, by: sort) }
    private var selectedHere: [MediaItem] { source.filter { media.selectedIDs.contains($0.id) } }

    var body: some View {
        List {
            Section {
                Picker("Sort", selection: $sort) {
                    ForEach(availableSorts) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                if kind == .screenRecordings {
                    Text("Videos with your screen's shape are listed here. Photos doesn't tell apps which videos are screen recordings, so check each one. Those of \(Int(app.settings.longScreenRecordingSeconds)) seconds or longer count as cleanup candidates.")
                        .font(.caption).foregroundStyle(.secondary)
                } else if kind == .largeVideos {
                    Text("Videos over \(ByteFormat.string(app.settings.largeVideoThreshold)) count as cleanup candidates.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if items.isEmpty {
                ContentUnavailableView("Nothing here", systemImage: kind.symbol,
                                       description: Text(media.access == .limited ? "With limited access, SpaceMate only sees the photos you selected." : "No items of this type were found."))
            } else if kind == .screenshots && sort == .date {
                ForEach(monthSections) { section in
                    Section(section.title) { ForEach(section.items) { row($0) } }
                }
            } else {
                Section { ForEach(items) { row($0) } }
            }
        }
        .navigationTitle(kind.title)
        .toolbar {
            Menu {
                Button("Select All Unprotected") {
                    media.selectedIDs.formUnion(source.map(\.id).filter { !app.isProtected($0) })
                }
                Button("Deselect All") { media.deselect(ids: source.map(\.id)) }
            } label: { Image(systemName: "checklist") }
            .accessibilityLabel("Selection options")
        }
        .safeAreaInset(edge: .bottom) {
            if !selectedHere.isEmpty {
                MediaSelectionBar(items: selectedHere) { reviewIDs = ReviewSelection(ids: selectedHere.map(\.id)) }
            }
        }
        .sheet(item: $reviewIDs) { MediaDeleteReviewView(itemIDs: $0.ids) }
    }

    private var availableSorts: [MediaSort] {
        kind == .screenshots ? [.size, .date] : MediaSort.allCases
    }

    private var monthSections: [MonthSection] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: items) { item -> Date in
            let date = item.creationDate ?? .distantPast
            return calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
        }
        return grouped.keys.sorted(by: >).map { month in
            MonthSection(title: month.formatted(.dateTime.month(.wide).year()), items: grouped[month] ?? [])
        }
    }

    private func row(_ item: MediaItem) -> some View {
        MediaRow(item: item)
    }
}

struct MonthSection: Identifiable {
    var id: String { title }
    let title: String
    let items: [MediaItem]
}

struct ReviewSelection: Identifiable {
    let id = UUID()
    let ids: [String]
}

struct MediaRow: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    let item: MediaItem

    var body: some View {
        let isProtected = app.isProtected(item.id)
        HStack(spacing: 12) {
            Button {
                media.toggleSelection(item.id)
            } label: {
                SelectionMark(isSelected: media.selectedIDs.contains(item.id))
            }
            .buttonStyle(.borderless)
            .disabled(isProtected)
            .accessibilityLabel(media.selectedIDs.contains(item.id) ? "Deselect" : "Select")

            NavigationLink(value: MediaRoute.item(item.id)) {
                HStack(spacing: 12) {
                    AssetThumbnail(localIdentifier: item.localIdentifier, service: media.service, side: 56)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 4) {
                            Text(item.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown date")
                                .font(.subheadline.weight(.medium))
                            if isProtected { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                            if !item.valuableReasons.isEmpty && !isProtected {
                                Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                                    .accessibilityLabel("May be valuable")
                            }
                        }
                        Text(item.kind == .screenshot || item.kind == .photo ? item.resolutionText : "\(item.durationText) · \(item.resolutionText)")
                            .font(.caption).foregroundStyle(.secondary)
                        SizeText(estimate: item.size).font(.caption)
                        if item.originalNotOnDevice {
                            Text("Original in iCloud only").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                }
            }
        }
    }
}

struct MediaSelectionBar: View {
    @Environment(MediaModel.self) private var media
    let items: [MediaItem]
    let onReview: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                VStack(alignment: .leading) {
                    Text("\(items.count) selected").font(.subheadline.weight(.semibold))
                    SizeText(estimate: items.map(\.size).total(), prefix: "Potential savings ").font(.caption)
                }
                Spacer()
                if media.isMeasuring {
                    Button("Stop") { media.cancelMeasuring() }.buttonStyle(.bordered)
                } else if items.contains(where: { $0.size.confidence != .measured }) {
                    Button("Measure") { media.measure(ids: items.map(\.id)) }.buttonStyle(.bordered)
                }
                Button("Review", action: onReview).buttonStyle(.borderedProminent)
            }
            if media.isMeasuring {
                ProgressView("Measuring… \(media.measuringCount) left").font(.caption)
            }
        }
        .padding()
        .background(.bar)
    }
}
