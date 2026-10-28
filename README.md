# SpaceMate

A native SwiftUI storage assistant for iPhone (built for an iPhone 13, iOS 17+).
SpaceMate shows real device storage, finds large videos, screenshots, screen recordings,
look-alike photos, duplicate files and leftover downloads, and helps you clean up safely,
without accounts, servers, analytics or uploads.

## What it does

| Area | What's real | Limits (set by iOS) |
| --- | --- | --- |
| **Home** | Capacity, used and available space measured by iOS (`URLResourceValues`), purgeable space, free-space target | No per-app or per-category breakdown. Only iOS Settings has that |
| **Photos & Videos** | Large videos, screen recordings, screenshots (PhotoKit), look-alike photos (on-device perceptual hashing), byte-exact duplicate check (SHA-256 of originals), preview, protected items, deletion with review | PhotoKit has no public file-size API, so sizes are **estimated** until you tap *Measure exact size*, which counts bytes for originals stored on the iPhone (never downloads from iCloud). Deleted items go to Recently Deleted; SpaceMate never empties it |
| **Files** | Folders/files you pick in the Files app: size analysis, sorting, type grouping, SHA-256 duplicate detection, possible repeated exports ("Mix (1).wav", "copy", "v2", "final"), Downloads, Quick Look preview, export with verified copy, share, deletion with review | Only sees what you pick; access ends when the app closes. Cloud files that aren't downloaded are never read (that would download them) |
| **Plan** | Ranked recommendations (quick wins / high impact / maintenance) with why, size, how it was calculated, reversibility, iCloud/sync effects and how-to | Guided steps (iPhone Storage, offloading apps, Messages, offline media, Safari, System Data) have no size estimate because iOS doesn't expose one |
| **Routine** | Free-space target, thresholds, weekly/monthly local-notification reminders, measured free-space trend chart, cleanup history with estimated vs. measured recovery | No background monitoring. Storage is measured whenever you open the app |

Every size in the app is labelled **Measured**, **Inspected** (reported by iOS for a file you picked) or **Estimated**.
Nothing is deleted without a review screen, an explicit acknowledgement toggle and a final button (plus iOS's own prompt for photos).
Items you mark **Protected** never appear in suggestions and can't be deleted from SpaceMate.

Apple offers no public deep link to *Settings → General → iPhone Storage*, so the guides give exact tap-by-tap
paths and an *Open Settings* button that opens SpaceMate's own Settings page (the only documented Settings URL).

## Project layout

```
SpaceMate/
  App/        App entry, AppModel (storage, persistence, protection, history), MediaModel, FilesModel
  Core/       Pure logic: sizes & confidence, storage math, SHA-256 hashing, duplicate grouping,
              perceptual hash + similarity grouping, file classification, recommendation engine,
              protection, history/trends, settings, JSON persistence
  Services/   StorageService, PhotoLibraryService (PhotoKit), FileScanner/FileOperations, NotificationService
  Views/      Home, Media, Files, Planner (+ guides), Routine, Settings, shared Components
SpaceMateTests/  XCTest unit tests (storage math, hashing, duplicates, ranking, savings, protection,
                 history, persistence failures, file scanning/deletion, permission states)
```

The Xcode project uses folder-synchronized groups (Xcode 16+): any file added to these folders is part of the build automatically.

## Install on your iPhone 13

You need a Mac with **Xcode 16 or later** (free from the Mac App Store) and a free Apple Account.

1. Clone this repository on your Mac and open `SpaceMate.xcodeproj`.
2. In Xcode, select the **SpaceMate** project → **SpaceMate** target → **Signing & Capabilities**.
   - Tick **Automatically manage signing**.
   - **Team**: choose your Apple Account (*Add an Account…* if it isn't listed; a free "Personal Team" works).
   - If Xcode says the bundle identifier is unavailable, change `com.yuvix.SpaceMate` to something unique, e.g. `com.yourname.SpaceMate`.
3. Connect the iPhone with a cable and unlock it. Tap **Trust** if asked.
4. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** and restart when prompted
   (the option appears after the phone has been connected to Xcode once).
5. In Xcode's toolbar choose your iPhone as the run destination and press **Run** (⌘R).
6. First launch with a free account: on the iPhone open **Settings → General → VPN & Device Management**,
   tap your developer certificate and **Trust** it, then open SpaceMate.

With a free Personal Team the app stays installed for 7 days; re-run from Xcode to renew it.
A paid Apple Developer Program membership gives one-year signing.

To run the tests: in Xcode choose an iPhone simulator and press ⌘U, or run
`xcodebuild test -project SpaceMate.xcodeproj -scheme SpaceMate -destination 'platform=iOS Simulator,name=iPhone 16'`.
GitHub Actions (`.github/workflows/ios.yml`) builds the app for iPhone and runs the tests on every push.

## Privacy

No account, no network requests of its own, no analytics, no ads. Saved data (a single JSON file protected by iOS data protection)
contains only settings, storage measurements, cleanup history and protected-item identifiers, never photos or file contents.
*Settings & Privacy* lets you clear history, the protected list, or everything.
