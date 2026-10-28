import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(MediaModel.self) private var media
    @Environment(\.dismiss) private var dismiss
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var confirmClearHistory = false
    @State private var confirmClearProtected = false
    @State private var confirmErase = false

    var body: some View {
        NavigationStack {
            List {
                Section("Privacy") {
                    privacyRow("iphone", "Everything stays on this iPhone. No account, no servers, no uploads.")
                    privacyRow("chart.bar.xaxis", "No analytics, tracking or advertising.")
                    privacyRow("network.slash", "SpaceMate makes no network requests of its own. Photos may download from iCloud when you preview an item.")
                    privacyRow("lock.doc", "Saved data is limited to sizes, dates, identifiers and your settings, and is encrypted by iOS.")
                    privacyRow("hand.raised", "Nothing is ever deleted without your explicit confirmation.")
                }

                Section("Permissions") {
                    LabeledContent("Photos", value: media.access.title)
                    LabeledContent("Notifications", value: notificationLabel)
                    Button("Open SpaceMate in Settings") { SystemSettings.openAppSettings() }
                }

                Section {
                    NavigationLink {
                        ProtectedItemsView()
                    } label: {
                        LabeledContent("Protected items", value: "\(app.data.protectedItems.count)")
                    }
                } footer: {
                    Text("Protected items are never included in cleanup suggestions or deletions.")
                }

                Section {
                    Button("Clear analysis & storage history") { confirmClearHistory = true }
                    Button("Clear protected list") { confirmClearProtected = true }
                    Button("Erase all SpaceMate data", role: .destructive) { confirmErase = true }
                } header: {
                    Text("Your data")
                } footer: {
                    Text("These only remove SpaceMate's own records. They never touch your photos or files.")
                }

                Section("Limitations") {
                    Text("iOS doesn't let apps list other apps' storage, clear their caches, or reduce System Data. SpaceMate shows device totals measured by iOS, analyzes media you allow, and inspects only files you pick.")
                    Text("Photo and video sizes are estimates unless marked Measured: PhotoKit has no public file-size API, so SpaceMate can count bytes only for items stored on this iPhone.")
                    Text("SpaceMate can't run continuously in the background. Reminders are scheduled notifications, and storage is checked whenever you open the app.")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)

                Section {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                }
            }
            .navigationTitle("Settings & Privacy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { notificationStatus = await NotificationService.authorizationStatus() }
            .confirmationDialog("Clear history?", isPresented: $confirmClearHistory, titleVisibility: .visible) {
                Button("Clear History", role: .destructive) { app.clearHistory() }
            } message: {
                Text("Removes recorded storage measurements and cleanup sessions.")
            }
            .confirmationDialog("Clear protected list?", isPresented: $confirmClearProtected, titleVisibility: .visible) {
                Button("Clear Protected List", role: .destructive) { app.clearProtectedItems() }
            } message: {
                Text("Items will no longer be excluded from suggestions. Your files and photos are not affected.")
            }
            .confirmationDialog("Erase all SpaceMate data?", isPresented: $confirmErase, titleVisibility: .visible) {
                Button("Erase", role: .destructive) { app.eraseAllAppData() }
            } message: {
                Text("Removes settings, history, protected list and reminders. Your photos and files are not affected.")
            }
        }
    }

    private var notificationLabel: String {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral: return "Allowed"
        case .denied: return "Off"
        case .notDetermined: return "Not requested"
        @unknown default: return "Unknown"
        }
    }

    private func privacyRow(_ symbol: String, _ text: String) -> some View {
        Label { Text(text).font(.subheadline) } icon: { Image(systemName: symbol).foregroundStyle(Color.accentColor) }
    }
}

struct ProtectedItemsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        List {
            if app.data.protectedItems.isEmpty {
                ContentUnavailableView("No protected items", systemImage: "lock.shield",
                                       description: Text("Protect recordings, mixes, footage and other important files from their detail screens."))
            }
            ForEach(app.data.protectedItems) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.displayName).font(.headline)
                    Text(item.location).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    if let bytes = item.bytes { Text(ByteFormat.string(bytes)).font(.caption).monospacedDigit() }
                    BackupStatusPicker(item: item)
                }
                .swipeActions {
                    Button("Unprotect", role: .destructive) { app.unprotect(id: item.id) }
                }
            }
        }
        .navigationTitle("Protected")
    }
}

/// Lets the user record "assumed" backups; verified statuses are set only by the app.
struct BackupStatusPicker: View {
    @Environment(AppModel.self) private var app
    let item: ProtectedItem

    var body: some View {
        Menu {
            ForEach(BackupStatus.userSelectable) { status in
                Button(status.label) { app.setBackupStatus(status, for: item.id) }
            }
        } label: {
            Label(item.backupStatus.label, systemImage: item.backupStatus.symbol)
                .font(.caption)
                .foregroundStyle(item.backupStatus == .verified ? Color.green : (item.backupStatus == .none ? Color.orange : Color.secondary))
        }
        .accessibilityHint("Change backup status")
    }
}
