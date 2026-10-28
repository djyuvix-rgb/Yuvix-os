import SwiftUI

enum MediaRoute: Hashable {
    case list(CandidateKind)
    case item(String)
    case similarGroups
    case similarGroup(String)
}

extension View {
    /// Registers the photo-library screens so any navigation stack (Photos tab, Plan tab) can show them.
    func mediaDestinations() -> some View {
        navigationDestination(for: MediaRoute.self) { route in
            switch route {
            case .list(let kind): MediaListView(kind: kind)
            case .item(let id): MediaDetailView(itemID: id)
            case .similarGroups: SimilarGroupsView()
            case .similarGroup(let id): SimilarGroupDetailView(groupID: id)
            }
        }
    }
}

struct MediaView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media

    var body: some View {
        NavigationStack {
            List {
                Section { accessSection }

                if media.access.canAnalyze {
                    Section {
                        categoryRow(.largeVideos, items: media.videos.filter { $0.kind == .video },
                                    detail: "Camera videos, largest first")
                        categoryRow(.screenRecordings, items: media.screenRecordings,
                                    detail: "Long recordings are prioritized")
                        categoryRow(.screenshots, items: media.screenshots, detail: "Grouped by month")
                        NavigationLink(value: MediaRoute.similarGroups) {
                            HStack {
                                Label(CandidateKind.similarPhotos.title, systemImage: CandidateKind.similarPhotos.symbol)
                                Spacer()
                                if media.isFindingSimilar {
                                    ProgressView(value: media.similarProgress).frame(width: 60)
                                } else if media.hasFoundSimilar {
                                    Text("\(media.similarGroups.count) groups").foregroundStyle(.secondary)
                                } else {
                                    Text("Not run").foregroundStyle(.secondary)
                                }
                            }
                        }
                    } header: {
                        Text("Review")
                    } footer: {
                        Text("Sizes are estimates from resolution and duration unless marked Measured. Open an item to measure its exact size on this iPhone.")
                    }
                }

                if let message = media.errorMessage {
                    Section { NoticeBox(style: .warning, title: "Note", message: message) }
                }
            }
            .navigationTitle("Photos & Videos")
            .refreshable { await media.analyze() }
            .mediaDestinations()
            .task {
                media.refreshAccess()
                if media.access.canAnalyze && !media.hasAnalyzed {
                    await media.analyze()
                    app.markMediaAnalyzed()
                }
            }
        }
    }

    @ViewBuilder private var accessSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(media.access.title, systemImage: media.access.canAnalyze ? "checkmark.shield" : "photo.badge.exclamationmark")
                .font(.headline)
            Text(media.access.message).font(.subheadline).foregroundStyle(.secondary)
            switch media.access {
            case .notDetermined:
                Button("Analyze My Photos & Videos") {
                    Task {
                        await media.requestAccessAndAnalyze()
                        if media.hasAnalyzed { app.markMediaAnalyzed() }
                    }
                }
                .buttonStyle(.borderedProminent)
            case .denied:
                Button("Open Settings") { SystemSettings.openAppSettings() }.buttonStyle(.bordered)
            case .limited:
                HStack {
                    Button("Select More Photos") { Task { await media.presentLimitedPicker() } }
                    Button("Allow Full Access") { SystemSettings.openAppSettings() }
                }
                .buttonStyle(.bordered)
            case .restricted, .full:
                EmptyView()
            }
            if media.isAnalyzing {
                ProgressView("Reading library…")
            }
        }
        .padding(.vertical, 4)
    }

    private func categoryRow(_ kind: CandidateKind, items: [MediaItem], detail: String) -> some View {
        NavigationLink(value: MediaRoute.list(kind)) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Label(kind.title, systemImage: kind.symbol)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(items.count)").monospacedDigit()
                    if !items.isEmpty {
                        Text("≈ " + items.map(\.size).total().formatted).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .disabled(!media.hasAnalyzed)
    }
}
