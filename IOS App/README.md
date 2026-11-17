# AI Wrapper (iOS)

SwiftUI iOS client for Genflowly, mirroring `genai-react-app` (same UI layout and the same backend API). All backend calls go to the environment's base URL (see Environments) under `/api/v1/*` with an Auth0-issued bearer token — endpoints, request/response shapes, and the NDJSON streaming protocol are identical to the web app.

## Build & run

- Open `AI Wrapper.xcodeproj` in Xcode and run the `AI Wrapper` scheme, or:

```sh
xcodebuild -project "AI Wrapper.xcodeproj" -scheme "AI Wrapper" \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

## Environments

Development and production settings (backend base URL + Auth0 client/audience) both live in `AI Wrapper/Config/AppConfig.swift`, mirroring the web app's `.env.development` / `.env.production`. Selection is by build configuration:

- **Debug builds** (Run from Xcode, simulator) → **development** (`https://api-development.genflowly.com`)
- **Release builds** from Xcode (Archive) → **production** (`https://genflowly.com`, audience `https://api.genflowly.com`). CI builds choose their stage per workflow, see Publishing below.
- To test production in a Debug run: Edit Scheme → Run → Arguments → add `--env-production`.

Because selection is tied to the build configuration (`#if DEBUG`), there is nothing to flip manually before shipping — an archive always targets production, and a local run always targets development unless `--env-production` is passed. `Endpoints` and `Auth0Service` read through `AppConfig`, so the environment applies everywhere automatically.

Each environment needs its own Auth0 **Native** application (see Authentication below); the production client ID is a TODO in `AppConfig.swift` until that app is created and authorized for the production API.

If more environments are added later (e.g. staging) or credentials need to move out of source, the next step up is per-configuration `.xcconfig` files feeding Info.plist keys, read at runtime via `Bundle.main` — the `AppConfig` API can stay the same.

## Authentication

The app uses Auth0 **Authorization Code + PKCE** natively via `ASWebAuthenticationSession` (no Auth0 SDK dependency). Tokens (access, refresh, ID) are stored in the Keychain; `Auth0Service.getAccessTokenSilently()` mirrors the web SDK: it returns the cached access token while fresh and silently refreshes it with the refresh token otherwise. After login the app POSTs `/api/v1/onboard`, exactly like the web `AuthContext`.

The callback URL follows Auth0's standard iOS convention and is derived from the bundle ID (`com.unbiase.ai`):

```
com.unbiase.ai://auth.genflowly.com/ios/com.unbiase.ai/callback
```

### Auth0 dashboard setup

Login fails with **"Callback URL mismatch"** until this is configured:

1. Auth0 Dashboard → **Applications → Create Application** → name it (e.g. "Genflowly iOS") → type **Native**. Custom-scheme callbacks are intended for Native apps — don't reuse the web SPA application.
2. In the app's **Settings**, paste the callback URL above into **Allowed Callback URLs** and **Allowed Logout URLs**. The comparison is an exact, character-for-character string match — keep the capitalization (`com.unbiase.ai`).
3. Under **Settings → Advanced Settings → Grant Types**, ensure **Authorization Code** and **Refresh Token** are checked (both are Native defaults). Refresh tokens are required because the app requests the `offline_access` scope.
4. **Authorize the app for the API** — this tenant requires an explicit client grant, so login fails with `Client "..." is not authorized to access resource server "https://api-development.genflowly.com"` (an `invalid_request` in the Auth0 logs) until it's granted:
   - Dashboard → **Applications → APIs** → open the API with identifier `https://api-development.genflowly.com` → **Machine to Machine Applications** tab → find the iOS app → toggle **Authorized** ON (and tick its scopes, if any). Despite the tab's M2M name, this is the grant used by the Authorization Code flow too.
   - If the app isn't listed there or the error persists: **Applications → (iOS app) → Settings → Advanced Settings → OAuth** → ensure **OIDC Conformant** is ON. Non-conformant clients can't request an `audience` without a resource-server grant and fail with this exact error.
   - Auth0 may show a one-time consent screen for the API scopes on first login — that's expected for native apps.
5. Copy the application's **Client ID** into `AppConfig.swift` (the `auth0` settings for the matching environment).
   Current client IDs:
   - iOS Native app (dev): `7uXHWmLk1uPO3u5y98sKsNnYzCxCTTNX`
   - iOS Native app (prod): not created yet — repeat these steps against the production API and fill in the TODO in `AppConfig.swift`
   - Web dev SPA: `VSKaAyEXLKM0LuZzJVhvH6RTT11LiNgE`
   - Web production SPA: `or3B2COf3BZX5HFPLHNVppkZanQYY8h1`

Notes:

- **No Info.plist URL-scheme registration is needed** — `ASWebAuthenticationSession` intercepts the redirect itself.
- Release builds automatically target production (see Environments) — the production Auth0 Native app must allowlist the same callback URL and be authorized for the production API identifier (`https://api.genflowly.com`).

## Project layout

- `Config/` — endpoints + Auth0 config (mirrors `src/config/`)
- `Auth/` — PKCE login, Keychain token storage (mirrors `Auth0Provider`/`AuthContext`)
- `Networking/`, `Services/`, `Models/` — API client with retry, one service per web service, Codable models (mirrors `src/services` + `src/models`)
- `State/` — `AuthStore`, `AIStore`, `ConversationStore`, `AppRouter`, `ToastCenter` (mirrors the React contexts + router)
- `Views/` — SwiftUI pages matching the web pages (Chat, History, Memory, Agents, Instructions, Settings) with the web's mobile layout
- `Theme/` — color palette from `src/styles/themes.scss`; icons in `Assets.xcassets` are copied from `src/assets/icons`

## Publishing (GitHub Actions)

| Branch | Workflow | Trigger | Stage | Result |
|---|---|---|---|---|
| `main` | `.github/workflows/prod-ios-app-store.yml` | Pushes to `main` that change the app in `IOS App/`, or by hand | production | Signed build in TestFlight for internal testers, selected on the App Store version draft |

A merge to `main` publishes when it changes anything in `IOS App/` other than Markdown files and Xcode's per-user `xcuserdata`. Backend, web and CI-only merges publish nothing, and so does a change to the workflow file alone. To publish without a merge, open Actions → **Production iOS TestFlight** → Run workflow with `main` selected, or run `gh workflow run prod-ios-app-store.yml --ref main`. A run started from any other branch is skipped. The workflow runs the unit tests on a simulator first and uploads one run at a time (a concurrency group). It waits for Apple to finish processing the build, then creates the App Store version for `MARKETING_VERSION` (or renames the unreleased one) and selects the build on it. **Nothing is submitted for review**: after testing the TestFlight build, open the version in App Store Connect, fill in What's New, and choose Add for Review → Submit. If that version is already waiting for review, the run fails after the upload (the build stays in TestFlight) because Apple won't change the build of a waiting version.

The recipe is `fastlane/Fastfile`; the same lanes run locally with the same environment variables:

```sh
fastlane ios unit_tests stage:development   # simulator unit tests
fastlane ios release                        # signed production build → TestFlight + App Store version draft
```

Runner: GitHub's `xcode-27` image (macOS 27, Xcode 27.2 pinned through `DEVELOPER_DIR`). Unit tests run on the `iPhone 18 Pro` simulator with its newest installed runtime; pass `device:"iPhone 17"` to the lane to use another one. macOS minutes are billed at 10× Linux minutes, which is why runs are manual.

### Versions and build numbers

- **Version** is assigned on CI: each run takes one patch above the highest version App Store Connect has seen (the latest upload or the live version), passed as `MARKETING_VERSION`. An unreleased version page is renamed to match. To start a new minor or major, raise Version in Xcode (target `AI Wrapper` → General); the workflow never goes below it. The number in the project is otherwise only used by local builds, so it doesn't follow each release.
- **Build number** is assigned on CI: the latest build in App Store Connect + 1, passed as `CURRENT_PROJECT_VERSION`. The `1` in the project is only used by local builds.

### Stage values and secrets on CI

The lane writes `BuildSettings/CI.xcconfig` (gitignored): it includes the stage file and overrides `AUTH0_CLIENT_ID` and `SENTRY_DSN` from the secrets. As a command-line xcconfig it outranks `Release.xcconfig`, so the placeholder client ID there never ships; the production lane refuses to build without `IOS_AUTH0_CLIENT_ID`.

Repository secrets:

| Secret | Value |
|---|---|
| `APP_STORE_CONNECT_API_KEY_ID` | Key ID of the App Store Connect API key |
| `APP_STORE_CONNECT_API_ISSUER_ID` | Issuer ID shown on the same page |
| `APP_STORE_CONNECT_API_KEY_P8` | The `.p8` file, base64-encoded |
| `IOS_DISTRIBUTION_CERT_P12` | Apple Distribution certificate + private key as `.p12`, base64-encoded |
| `IOS_DISTRIBUTION_CERT_PASSWORD` | Password given when exporting the `.p12` |
| `IOS_DISTRIBUTION_CERT_ID` | Optional. Only when the team has several distribution certificates: the ID of the one in the `.p12`, so the profile is built for it |

Environment secrets (`production`, like the web app's `AUTH0_SPA_CLIENT_ID`):

| Secret | Value |
|---|---|
| `IOS_AUTH0_CLIENT_ID` | Client ID of the production Auth0 **Native** iOS app. Required |
| `IOS_SENTRY_DSN` | Optional. Sentry DSN for production |

```sh
gh secret set APP_STORE_CONNECT_API_KEY_ID --body "ABC123DEFG"
gh secret set APP_STORE_CONNECT_API_ISSUER_ID --body "00000000-0000-0000-0000-000000000000"
base64 -i ~/Downloads/AuthKey_ABC123DEFG.p8 | gh secret set APP_STORE_CONNECT_API_KEY_P8
base64 -i ~/Desktop/distribution.p12 | gh secret set IOS_DISTRIBUTION_CERT_P12
gh secret set IOS_DISTRIBUTION_CERT_PASSWORD --body "<p12 password>"
gh secret set IOS_AUTH0_CLIENT_ID --env production --body "<production iOS Native app client ID>"
```

### One-time setup

1. **Developer portal** → Certificates, Identifiers & Profiles → Identifiers: the App ID `com.unbiase.ai` must exist with **Associated Domains** enabled (the Release entitlements declare `applinks:genflowly.com`; a profile without the capability fails signing).
2. **App Store Connect** → Apps → New App with that bundle ID, then the parts a binary upload cannot supply: name, subtitle, description, keywords, screenshots, privacy policy URL (`https://genflowly.com/privacy-policy`), Support URL (`https://genflowly.com/support`), App Privacy answers, age rating, pricing, and the App Review contact. The workflow only uploads the build and selects it on the version page; submitting is manual.
3. **TestFlight** → Internal Testing: a group with automatic distribution on, with you in it. Every upload appears there.
4. **API key**: Users and Access → Integrations → App Store Connect API → Team Keys → Generate, role **Admin** (the key creates provisioning profiles, and Admin is the role certain to have Certificates, Identifiers & Profiles access). Download the `.p8` once; note the Key ID and Issuer ID.
5. **Distribution certificate**: Xcode → Settings → Accounts → the team → Manage Certificates → `+` → Apple Distribution. Then Keychain Access → login → My Certificates → right-click "Apple Distribution: …" → Export as `.p12` with a password.
6. **Auth0**: the production iOS Native app (same steps as Authentication above, authorized for `https://api.genflowly.com`), its client ID in the production `IOS_AUTH0_CLIENT_ID` secret.

Export compliance: `ITSAppUsesNonExemptEncryption = false` is set in both Info plists (HTTPS only), so uploads never wait on the encryption question.
