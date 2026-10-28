import SwiftUI

struct SimilarGroupsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media

    var body: some View {
        List {
            Section {
                if media.isFindingSimilar {
                    VStack(alignment: .leading, spacing: 8) {
                        ProgressView(value: media.similarProgress) {
                            Text("Comparing photos… \(media.similarScanned) of \(media.similarTotal)")
                        }
                        Button("Stop", role: .cancel) { media.cancelSimilar() }
                    }
                } else {
                    Button(media.hasFoundSimilar ? "Search Again" : "Find Similar Photos") {
                        media.findSimilar()
                        app.markMediaAnalyzed()
                    }
                    .disabled(!media.access.canAnalyze)
                }
            } footer: {
                Text("SpaceMate compares tiny on-device thumbnails to find photos that look alike. “Similar” never means “duplicate”. Open a group and use “Check if identical” to compare the actual files. SpaceMate never picks which photo to keep.")
            }

            if media.hasFoundSimilar && media.similarGroups.isEmpty {
                ContentUnavailableView("No similar photos found", systemImage: "square.on.square")
            }

            ForEach(media.similarGroups) { group in
                NavigationLink(value: MediaRoute.similarGroup(group.id)) {
                    SimilarGroupRow(group: group)
                }
            }
        }
        .navigationTitle("Similar Photos")
    }
}

struct SimilarGroupRow: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    let group: SimilarGroup

    var body: some View {
        let members = media.items(group.memberIDs)
        let savings = RecommendationEngine.reclaimable(
            CleanupCandidate(id: group.id, kind: .similarPhotos, members: members.map { .init(id: $0.id, bytes: $0.size.bytes) }, confidence: .estimated),
            protectedIDs: app.protectedIDs
        )
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                ForEach(members.prefix(4)) { item in
                    AssetThumbnail(localIdentifier: item.localIdentifier, service: media.service, side: 52)
                }
                if members.count > 4 {
                    Text("+\(members.count - 4)").font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack {
                Text("\(members.count) look-alike photos").font(.subheadline)
                Spacer()
                if let savings { Text("up to ≈ \(ByteFormat.string(savings.bytes))").font(.caption).foregroundStyle(.secondary) }
            }
            VerificationLabel(verification: group.verification)
        }
        .padding(.vertical, 4)
    }
}

struct VerificationLabel: View {
    let verification: SimilarGroup.Verification

    var body: some View {
        switch verification {
        case .unchecked:
            Label("Similar (not checked for identical files)", systemImage: "eye").font(.caption).foregroundStyle(.secondary)
        case .checking:
            Label("Checking…", systemImage: "hourglass").font(.caption).foregroundStyle(.secondary)
        case .identical:
            Label("Identical files confirmed", systemImage: "checkmark.seal.fill").font(.caption).foregroundStyle(.green)
        case .different:
            Label("Look alike but files differ", systemImage: "square.on.square").font(.caption).foregroundStyle(.orange)
        case .couldNotCheck(let reason):
            Label("Couldn't check: \(reason)", systemImage: "questionmark.circle").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct SimilarGroupDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    let groupID: String
    @State private var review: ReviewSelection?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 8)]

    var body: some View {
        if let group = media.similarGroups.first(where: { $0.id == groupID }) {
            let members = media.items(group.memberIDs)
            let selected = members.filter { media.selectedIDs.contains($0.id) }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VerificationLabel(verification: group.verification)
                    Text("Tap the photos you want to remove. Use the expand button to see one full size. Keep at least the one you like best.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(members) { item in
                            tile(item)
                        }
                    }
                    if !selected.isEmpty && selected.count == members.count {
                        NoticeBox(style: .warning, title: "Every photo in this group is selected",
                                  message: "Deleting all of them keeps no copy. Deselect the one you want to keep.")
                    }
                    if group.verification == .unchecked || group.verification == .different {
                        Button {
                            Task { await media.verifyIdentical(groupID: group.id) }
                        } label: {
                            Label("Check if identical", systemImage: "number")
                        }
                        .buttonStyle(.bordered)
                        Text("Compares the stored files byte-for-byte (SHA-256). Works only for originals on this iPhone; nothing is downloaded.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding()
            }
            .navigationTitle("\(members.count) Similar")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                if !selected.isEmpty {
                    MediaSelectionBar(items: selected) { review = ReviewSelection(ids: selected.map(\.id)) }
                }
            }
            .sheet(item: $review) { MediaDeleteReviewView(itemIDs: $0.ids) }
        } else {
            ContentUnavailableView("Group no longer available", systemImage: "square.on.square")
        }
    }

    private func tile(_ item: MediaItem) -> some View {
        let isSelected = media.selectedIDs.contains(item.id)
        let isProtected = app.isProtected(item.id)
        return ZStack(alignment: .topTrailing) {
            Button {
                if !isProtected { media.toggleSelection(item.id) }
            } label: {
                AssetThumbnail(localIdentifier: item.localIdentifier, service: media.service, side: 104)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(isSelected ? Color.accentColor : .clear, lineWidth: 3))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Photo"), \(item.size.formatted)")
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityHint(isProtected ? "Protected" : "Toggles selection")

            if isProtected {
                Image(systemName: "lock.fill").padding(6).background(.thinMaterial, in: Circle()).padding(4)
                    .accessibilityLabel("Protected")
            } else {
                SelectionMark(isSelected: isSelected).padding(4).background(.thinMaterial, in: Circle()).padding(4)
                    .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .bottomLeading) {
            NavigationLink(value: MediaRoute.item(item.id)) {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.caption.weight(.semibold))
                    .padding(6)
                    .background(.thinMaterial, in: Circle())
            }
            .padding(4)
            .accessibilityLabel("Open details")
        }
    }
}
