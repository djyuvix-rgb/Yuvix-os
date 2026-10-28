import AVKit
import SwiftUI
import UIKit

struct MediaDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    let itemID: String
    @State private var player: AVPlayer?
    @State private var image: UIImage?
    @State private var review: ReviewSelection?

    var body: some View {
        if let item = media.itemsByID[itemID] {
            List {
                Section { preview(item) }
                    .listRowInsets(EdgeInsets())

                Section("Details") {
                    LabeledContent("Type", value: typeName(item))
                    LabeledContent("Date", value: item.creationDate?.formatted(date: .long, time: .shortened) ?? "Unknown")
                    if item.duration > 0 { LabeledContent("Duration", value: item.durationText) }
                    LabeledContent("Resolution", value: item.resolutionText)
                    LabeledContent("Size") { SizeText(estimate: item.size) }
                    Text(item.size.confidence.explanation).font(.caption).foregroundStyle(.secondary)
                    measureRow(item)
                }

                if !item.valuableReasons.isEmpty {
                    Section {
                        NoticeBox(style: .warning, title: "Protect before cleaning?", message: item.valuableReasons.joined(separator: "\n"))
                    }
                }

                Section {
                    Toggle(isOn: Binding(get: { app.isProtected(item.id) }, set: { _ in app.toggleProtection(media: item) })) {
                        Label("Protect this item", systemImage: "lock.shield")
                    }
                    if !app.isProtected(item.id) {
                        Toggle(isOn: Binding(get: { media.selectedIDs.contains(item.id) }, set: { _ in media.toggleSelection(item.id) })) {
                            Label("Select for cleanup", systemImage: "checkmark.circle")
                        }
                        Button(role: .destructive) {
                            review = ReviewSelection(ids: [item.id])
                        } label: {
                            Label("Review & Delete…", systemImage: "trash")
                        }
                    }
                } footer: {
                    Text("Protected items are excluded from suggestions and can't be deleted from SpaceMate.")
                }
            }
            .navigationTitle(typeName(item))
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $review) { MediaDeleteReviewView(itemIDs: $0.ids) }
            .onDisappear { player?.pause() }
        } else {
            ContentUnavailableView("Item not available", systemImage: "photo", description: Text("It may have been deleted."))
        }
    }

    @ViewBuilder private func preview(_ item: MediaItem) -> some View {
        Group {
            if item.kind == .video || item.kind == .screenRecording {
                if let player {
                    VideoPlayer(player: player)
                } else {
                    ProgressView("Loading video…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task {
                            if let playerItem = await media.service.playerItem(for: item.localIdentifier) {
                                player = AVPlayer(playerItem: playerItem)
                            }
                        }
                }
            } else if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task { image = await media.service.thumbnail(for: item.localIdentifier, size: CGSize(width: 1200, height: 1200)) }
            }
        }
        .frame(height: 320)
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    @ViewBuilder private func measureRow(_ item: MediaItem) -> some View {
        switch media.measureStates[item.id] {
        case .measuring:
            ProgressView("Measuring…")
        case .notOnDevice:
            NoticeBox(style: .info, title: "Original stored in iCloud",
                      message: "This iPhone keeps only an optimized version, so deleting it frees less space here than the estimate. SpaceMate doesn't download originals to measure them.")
        case .failed(let message):
            NoticeBox(style: .warning, title: "Couldn't measure", message: message)
        case nil:
            if item.size.confidence != .measured {
                Button("Measure exact size") { media.measure(ids: [item.id]) }
                    .disabled(media.isMeasuring)
            }
        }
    }

    private func typeName(_ item: MediaItem) -> String {
        switch item.kind {
        case .video: return "Video"
        case .screenRecording: return "Screen recording"
        case .screenshot: return "Screenshot"
        case .photo: return item.isLivePhoto ? "Live Photo" : "Photo"
        }
    }
}
