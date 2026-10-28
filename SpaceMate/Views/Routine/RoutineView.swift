import Charts
import SwiftUI

struct RoutineView: View {
    @Environment(AppModel.self) private var app
    @State private var reminderWarning: String?

    var body: some View {
        NavigationStack {
            List {
                targetSection
                reminderSection
                trendSection
                recoverySection
                sessionsSection
                Section {
                    NavigationLink { GuidesListView() } label: {
                        Label("iPhone Storage guides", systemImage: "book")
                    }
                }
            }
            .navigationTitle("Routine")
            .navigationDestination(for: SettingsGuide.self) { GuideDetailView(guide: $0) }
        }
    }

    // MARK: Target

    private var targetSection: some View {
        Section {
            Stepper(value: Binding(
                get: { Int(app.settings.freeSpaceTarget / ByteFormat.gigabyte) },
                set: { value in app.updateSettings { $0.freeSpaceTarget = Int64(value) * ByteFormat.gigabyte } }
            ), in: 1...200) {
                LabeledContent("Keep at least", value: ByteFormat.string(app.settings.freeSpaceTarget))
            }
            Stepper(value: Binding(
                get: { Int(app.settings.largeVideoThreshold / ByteFormat.megabyte) },
                set: { value in app.updateSettings { $0.largeVideoThreshold = Int64(value) * ByteFormat.megabyte } }
            ), in: 25...2000, step: 25) {
                LabeledContent("Large video from", value: ByteFormat.string(app.settings.largeVideoThreshold))
            }
            Stepper(value: Binding(
                get: { Int(app.settings.largeFileThreshold / ByteFormat.megabyte) },
                set: { value in app.updateSettings { $0.largeFileThreshold = Int64(value) * ByteFormat.megabyte } }
            ), in: 10...2000, step: 10) {
                LabeledContent("Large file from", value: ByteFormat.string(app.settings.largeFileThreshold))
            }
            Stepper(value: Binding(
                get: { Int(app.settings.longScreenRecordingSeconds) },
                set: { value in app.updateSettings { $0.longScreenRecordingSeconds = Double(value) } }
            ), in: 10...1800, step: 10) {
                LabeledContent("Long screen recording", value: "\(Int(app.settings.longScreenRecordingSeconds)) s+")
            }
        } header: {
            Text("Targets")
        } footer: {
            if let snapshot = app.snapshot {
                Text(app.bytesNeededForTarget == 0
                     ? "You currently have \(ByteFormat.string(snapshot.available)) free, which meets your target."
                     : "You currently have \(ByteFormat.string(snapshot.available)) free. Free about \(ByteFormat.string(app.bytesNeededForTarget)) to reach your target.")
            }
        }
    }

    // MARK: Reminders

    private var reminderSection: some View {
        Section {
            Picker("Review reminder", selection: Binding(
                get: { app.settings.reminderFrequency },
                set: { value in
                    app.updateSettings { $0.reminderFrequency = value }
                    scheduleReminder()
                }
            )) {
                ForEach(ReminderFrequency.allCases) { Text($0.label).tag($0) }
            }
            if app.settings.reminderFrequency != .off {
                Picker("Time", selection: Binding(
                    get: { app.settings.reminderHour },
                    set: { value in
                        app.updateSettings { $0.reminderHour = value }
                        scheduleReminder()
                    }
                )) {
                    ForEach(6..<23) { hour in
                        Text(Calendar.current.date(from: DateComponents(hour: hour))?.formatted(date: .omitted, time: .shortened) ?? "\(hour):00").tag(hour)
                    }
                }
            }
            if let reminderWarning {
                NoticeBox(style: .warning, title: "Notifications are off", message: reminderWarning)
                Button("Open Settings") { SystemSettings.openAppSettings() }
            }
        } header: {
            Text("Reminders")
        } footer: {
            Text(app.settings.reminderFrequency == .monthly
                 ? "Reminds you on the 1st of each month. SpaceMate can't monitor storage in the background; it checks your free space each time you open it."
                 : "Weekly reminders arrive on Sundays. SpaceMate can't monitor storage in the background; it checks your free space each time you open it.")
        }
    }

    private func scheduleReminder() {
        Task {
            let ok = await app.applyReminderSettings()
            reminderWarning = ok ? nil : "Allow notifications for SpaceMate in Settings to get reminders."
        }
    }

    // MARK: Trend

    @ViewBuilder private var trendSection: some View {
        let points = StorageHistory.dailySeries(app.data.snapshots)
        let trend = StorageHistory.trendBytesPerWeek(app.data.snapshots)
        Section {
            if points.count < 2 {
                Text("SpaceMate records your free space each time you open it. A trend appears after readings on at least two different days.")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(points) { point in
                        LineMark(x: .value("Day", point.day, unit: .day), y: .value("Free (GB)", Double(point.available) / 1e9))
                            .interpolationMethod(.monotone)
                        PointMark(x: .value("Day", point.day, unit: .day), y: .value("Free (GB)", Double(point.available) / 1e9))
                            .symbolSize(20)
                    }
                    RuleMark(y: .value("Target", Double(app.settings.freeSpaceTarget) / 1e9))
                        .foregroundStyle(.orange)
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                        .annotation(position: .top, alignment: .leading) {
                            Text("Target").font(.caption2).foregroundStyle(.orange)
                        }
                }
                .chartYAxisLabel("GB free")
                .frame(height: 200)
                .accessibilityLabel("Free space over time")
            }
            if let trend, let snapshot = app.snapshot {
                let direction = trend < 0 ? "shrinking" : "growing"
                Text("Free space is \(direction) by about \(ByteFormat.string(Int64(abs(trend)))) per week, based on \(app.data.snapshots.count) readings.")
                    .font(.footnote)
                if let days = StorageHistory.daysUntilBelow(target: app.settings.freeSpaceTarget, available: snapshot.available, bytesPerWeek: trend), days > 0 {
                    Text("At this rate you'd drop below your target in about \(days) days.").font(.footnote).foregroundStyle(.orange)
                }
            }
            Button("Record a Measurement Now") { app.refreshStorage() }
        } header: {
            Text("Free space over time")
        } footer: {
            Text("Every point is an actual measurement from iOS, not an estimate.")
        }
    }

    // MARK: Recovery

    @ViewBuilder private var recoverySection: some View {
        let summary = StorageHistory.summary(app.data.sessions)
        Section {
            LabeledContent("Cleanup sessions", value: "\(summary.sessions)")
            LabeledContent("Items removed", value: "\(summary.itemsRemoved)")
            LabeledContent("Estimated size removed", value: ByteFormat.string(summary.estimatedBytes))
            LabeledContent("Measured increase in free space", value: ByteFormat.string(summary.measuredBytes))
        } header: {
            Text("Recovered space")
        } footer: {
            Text("Estimated is the size of what you deleted. Measured is the change iOS reported right after each cleanup, so it includes other activity on the phone. Photos deletions only free space after leaving Recently Deleted, so measured values are often lower.")
        }
    }

    @ViewBuilder private var sessionsSection: some View {
        if !app.data.sessions.isEmpty {
            Section("History") {
                ForEach(app.data.sessions.sorted { $0.date > $1.date }) { session in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Label(session.source == .photos ? "Photos" : "Files",
                                  systemImage: session.source == .photos ? "photo" : "folder")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text(session.date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                        }
                        Text("\(session.itemCount) item\(session.itemCount == 1 ? "" : "s") · \(session.estimated.confidence.label.lowercased()) \(session.estimated.formatted)")
                            .font(.caption)
                        if let before = session.before, let after = session.after {
                            Text("Free space: \(ByteFormat.string(before.available)) → \(ByteFormat.string(after.available)) (measured)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let note = session.note { Text(note).font(.caption2).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
}
