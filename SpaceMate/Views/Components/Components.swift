import Photos
import QuickLook
import SwiftUI
import UIKit

/// Ring showing used vs. total device storage.
struct StorageRing: View {
    let fraction: Double
    var lineWidth: CGFloat = 18

    var tint: Color {
        switch fraction {
        case ..<0.75: return .accentColor
        case ..<0.9: return .orange
        default: return .red
        }
    }

    var body: some View {
        ZStack {
            Circle().stroke(Color(.systemFill), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, fraction)))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.4), value: fraction)
            VStack(spacing: 2) {
                Text(fraction, format: .percent.precision(.fractionLength(0)))
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .monospacedDigit()
                Text("used").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Storage used")
        .accessibilityValue(Text(fraction, format: .percent.precision(.fractionLength(0))))
    }
}

/// Small capsule saying how a number was obtained.
struct ConfidenceBadge: View {
    let confidence: SizeConfidence

    var color: Color {
        switch confidence {
        case .measured: return .green
        case .reported: return .blue
        case .estimated: return .orange
        }
    }

    var body: some View {
        Text(confidence.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
            .accessibilityLabel("\(confidence.label) size")
    }
}

struct SizeText: View {
    let estimate: ByteEstimate
    var prefix: String = ""

    var body: some View {
        HStack(spacing: 6) {
            Text(prefix + (estimate.confidence == .estimated ? "≈ " : "") + estimate.formatted)
                .monospacedDigit()
            ConfidenceBadge(confidence: estimate.confidence)
        }
    }
}

struct NoticeBox: View {
    enum Style { case info, warning, danger }
    let style: Style
    let title: String
    let message: String

    var color: Color {
        switch style {
        case .info: return .blue
        case .warning: return .orange
        case .danger: return .red
        }
    }

    var symbol: String {
        switch style {
        case .info: return "info.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .danger: return "exclamationmark.octagon.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(color).font(.body)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(message).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct LabeledFigure: View {
    let title: String
    let value: String
    var caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.headline).monospacedDigit()
            if let caption { Text(caption).font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Thumbnail of a photo-library item, loaded on demand.
struct AssetThumbnail: View {
    let localIdentifier: String
    let service: PhotoLibraryService
    var side: CGFloat = 64

    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ZStack {
            Rectangle().fill(Color(.tertiarySystemFill))
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityHidden(true)
        .task(id: localIdentifier) {
            image = await service.thumbnail(for: localIdentifier, size: CGSize(width: side * displayScale, height: side * displayScale))
        }
    }
}

struct SelectionMark: View {
    let isSelected: Bool
    var body: some View {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
            .accessibilityLabel(isSelected ? "Selected" : "Not selected")
    }
}

/// Quick Look preview for a local file.
struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// Exports a copy of a file to a location the user picks in Files, then reports where it went.
struct DocumentExporter: UIViewControllerRepresentable {
    let url: URL
    let onFinish: ([URL]) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onFinish: ([URL]) -> Void
        init(onFinish: @escaping ([URL]) -> Void) { self.onFinish = onFinish }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { onFinish(urls) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onFinish([]) }
    }
}

enum SystemSettings {
    /// The only documented Settings URL: SpaceMate's own page in the Settings app.
    @MainActor
    static func openAppSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}

extension Date {
    var relativeDescription: String {
        RelativeDateTimeFormatter().localizedString(for: self, relativeTo: Date())
    }
}
