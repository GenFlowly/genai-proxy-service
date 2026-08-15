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
- **Release builds** (Archive, TestFlight, App Store) → **production** (`https://genflowly.com`, audience `https://api.genflowly.com`)
- To test production in a Debug run: Edit Scheme → Run → Arguments → add `--env-production`.

Because selection is tied to the build configuration (`#if DEBUG`), there is nothing to flip manually before shipping — an archive always targets production, and a local run always targets development unless `--env-production` is passed. `Endpoints` and `Auth0Service` read through `AppConfig`, so the environment applies everywhere automatically.

Each environment needs its own Auth0 **Native** application (see Authentication below); the production client ID is a TODO in `AppConfig.swift` until that app is created and authorized for the production API.

If more environments are added later (e.g. staging) or credentials need to move out of source, the next step up is per-configuration `.xcconfig` files feeding Info.plist keys, read at runtime via `Bundle.main` — the `AppConfig` API can stay the same.

## Authentication

The app uses Auth0 **Authorization Code + PKCE** natively via `ASWebAuthenticationSession` (no Auth0 SDK dependency). Tokens (access, refresh, ID) are stored in the Keychain; `Auth0Service.getAccessTokenSilently()` mirrors the web SDK: it returns the cached access token while fresh and silently refreshes it with the refresh token otherwise. After login the app POSTs `/api/v1/onboard`, exactly like the web `AuthContext`.

The callback URL follows Auth0's standard iOS convention and is derived from the bundle ID (`nkirit.AI-Wrapper`):

```
nkirit.AI-Wrapper://auth.genflowly.com/ios/nkirit.AI-Wrapper/callback
```

### Auth0 dashboard setup

Login fails with **"Callback URL mismatch"** until this is configured:

1. Auth0 Dashboard → **Applications → Create Application** → name it (e.g. "Genflowly iOS") → type **Native**. Custom-scheme callbacks are intended for Native apps — don't reuse the web SPA application.
2. In the app's **Settings**, paste the callback URL above into **Allowed Callback URLs** and **Allowed Logout URLs**. The comparison is an exact, character-for-character string match — keep the capitalization (`nkirit.AI-Wrapper`).
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
