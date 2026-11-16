# iOS app stages

One file per stage, like the web's `.env.development` and `.env.production`. This is the only
place these values live: the `Info-*.plist` files reference them as `$(KEY)`, and code reads them
through `AppConfig`.

| Build | Stage |
|---|---|
| Debug (Xcode Run, simulator) | The `#include` line in `../Debug.xcconfig` |
| Release (Archive, TestFlight, App Store) | Always production, set in `../Release.xcconfig` |

**To switch a Debug build:** change that one `#include` line. Log out of the app first, because a
session from another stage has a token for the wrong backend.

**For one build only:** `xcodebuild -xcconfig "BuildSettings/Environments/development.xcconfig" ...`

**Writing a URL:** xcconfig treats `//` as a comment, so write `https:/$()/host`.
Every stage has to define the same keys; a unit test checks that.

**The app's name:** `APP_DISPLAY_NAME` is what the home screen and system dialogs show. The target, scheme and bundle ID keep their original name, because sign-in and the keychain depend on the bundle ID.
