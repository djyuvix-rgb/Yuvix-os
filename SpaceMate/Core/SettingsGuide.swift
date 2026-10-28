import Foundation

/// A guided manual step for storage that SpaceMate can't manage itself.
/// Apple offers no public deep link into these Settings pages, so each guide gives exact navigation.
struct SettingsGuide: Identifiable, Hashable {
    let id: String
    let title: String
    let symbol: String
    let summary: String
    /// Tap-by-tap path starting from the Settings home screen.
    let steps: [String]
    let details: [String]
    let whatYouMayLose: String
    let reversibility: Reversibility
    let risk: RiskLevel

    static let all: [SettingsGuide] = [
        SettingsGuide(
            id: "iphone-storage",
            title: "Review iPhone Storage",
            symbol: "internaldrive",
            summary: "iOS's own storage page shows the real space used by each app and lists Apple's recommendations. Only iOS can see this; SpaceMate can't.",
            steps: ["Settings", "General", "iPhone Storage"],
            details: [
                "Wait for the bar at the top to finish calculating.",
                "Read the recommendations under the bar (for example “Offload Unused Apps” or “Review Large Attachments”).",
                "Scroll the app list. It is sorted by size. Tap an app to see its App Size and Documents & Data.",
            ],
            whatYouMayLose: "Nothing. This page only shows information until you choose an action.",
            reversibility: .notApplicable,
            risk: .low
        ),
        SettingsGuide(
            id: "offload-apps",
            title: "Offload apps you rarely use",
            symbol: "icloud.and.arrow.down",
            summary: "Offloading removes an app but keeps its documents and data. Reinstalling restores everything, if the app is still available on the App Store.",
            steps: ["Settings", "General", "iPhone Storage", "tap an app", "Offload App"],
            details: [
                "To offload one app, tap it in the list and choose Offload App.",
                "To let iOS do it automatically, go to Settings → App Store → Offload Unused Apps.",
                "“Delete App” is different: it also deletes the app's data.",
            ],
            whatYouMayLose: "The app until you reinstall it. If the developer removes it from the App Store, you may not be able to reinstall it.",
            reversibility: .notApplicable,
            risk: .low
        ),
        SettingsGuide(
            id: "messages",
            title: "Review large Messages attachments",
            symbol: "message",
            summary: "Videos and photos sent in Messages are stored separately from your photo library and can add up to several gigabytes.",
            steps: ["Settings", "General", "iPhone Storage", "Messages", "Review Large Attachments"],
            details: [
                "Swipe left on an attachment to delete it, or tap Edit to select several.",
                "Optional: Settings → Apps → Messages → Keep Messages lets older conversations be deleted automatically. This deletes messages too, not just attachments.",
            ],
            whatYouMayLose: "Deleted attachments are removed from that conversation. If Messages in iCloud is on, they're removed from your other devices too.",
            reversibility: .permanent,
            risk: .medium
        ),
        SettingsGuide(
            id: "media-downloads",
            title: "Remove offline music, video and podcast downloads",
            symbol: "music.note",
            summary: "Downloaded songs, films, TV episodes and podcasts are kept for offline playback and can usually be downloaded again.",
            steps: ["Settings", "General", "iPhone Storage", "Music / TV / Podcasts"],
            details: [
                "Music: swipe left on an artist or All Songs to remove downloads. Music in your library stays available to stream.",
                "TV and Podcasts: open the app's storage page and remove downloaded episodes you've watched or heard.",
                "Streaming apps (Spotify, Netflix, YouTube and so on) manage their own downloads. Open the app and look for its Downloads or Storage setting.",
            ],
            whatYouMayLose: "Offline playback until you download again. Anything you bought or that's in your library can normally be downloaded again.",
            reversibility: .notApplicable,
            risk: .low
        ),
        SettingsGuide(
            id: "app-caches",
            title: "Check app-specific downloads and caches",
            symbol: "app.badge",
            summary: "Some apps (social, messaging, streaming, browsers) store large caches. iOS doesn't let any other app clear them, so each app has to do it itself.",
            steps: ["Settings", "General", "iPhone Storage", "tap an app", "check Documents & Data"],
            details: [
                "If Documents & Data is large, open that app and look for a setting like Storage, Data Usage, Clear Cache or Downloads.",
                "If the app offers no option, deleting and reinstalling it clears its cache, but also its local data. Only do this for apps whose data is saved to an account.",
            ],
            whatYouMayLose: "Depends on the app. Clearing a cache is usually safe; deleting an app deletes data that wasn't synced.",
            reversibility: .permanent,
            risk: .medium
        ),
        SettingsGuide(
            id: "safari",
            title: "Clear Safari website data (optional)",
            symbol: "safari",
            summary: "Safari stores website data and caches. Clearing them can free some space, but how much varies. Often it's very little.",
            steps: ["Settings", "Apps", "Safari", "Advanced", "Website Data"],
            details: [
                "On this page you can remove data for individual sites, which is better than clearing everything.",
                "“Clear History and Website Data” on the main Safari settings page also signs you out of websites.",
                "On iOS 17 the path is Settings → Safari (without “Apps”).",
            ],
            whatYouMayLose: "You may be signed out of websites and lose site preferences. Browsing history is lost if you clear history.",
            reversibility: .permanent,
            risk: .low
        ),
        SettingsGuide(
            id: "system-data",
            title: "Understand iOS and System Data",
            symbol: "gearshape.2",
            summary: "“iOS” is the operating system itself and can't be reduced. “System Data” holds caches, logs and temporary files that iOS manages and shrinks on its own when space runs low.",
            steps: ["Settings", "General", "iPhone Storage", "scroll to the bottom", "System Data"],
            details: [
                "No app, including SpaceMate, can clear System Data directly, and you shouldn't try tools that claim to.",
                "System Data often shrinks after iOS updates, when storage gets tight, or after a restart, but the effect isn't guaranteed or predictable.",
                "Never jailbreak or install profiles to “clean” system files. That risks your data and security.",
            ],
            whatYouMayLose: "Nothing. This guide is informational.",
            reversibility: .notApplicable,
            risk: .low
        ),
    ]

    static func guide(id: String) -> SettingsGuide? { all.first { $0.id == id } }
}
