# Admin Panel

Internal admin tool for genai-proxy-server. Currently manages the **system-wide
AI vendor API keys** (OpenAI / Claude / Gemini) stored KMS-encrypted in the
`SystemVendorApiKeys` DynamoDB table (PK = `aiVendor`, so server-side lookup is
a single O(1) `GetItem`) and the **system instructions** (Instructions page).

## Auth architecture

The admin panel shares the Auth0 **tenant** (`auth.genflowly.com`) with
genai-react-app but has its **own Auth0 application** (its own clientId). This
gives single sign-on with separated accounts:

- **One identity, one session.** Logging in to either app creates a session at
  `auth.genflowly.com`. Opening the other app silently completes login for the
  same email — no second credential prompt.
- **Separate accounts per app.** Customer profiles are keyed by
  `(sub, client)` in DynamoDB, where `client` is `ADMIN_PANEL` here and
  `REACT_APP` for the web app. The same person therefore has two independent
  customer accounts (different customerIds, API keys, conversations).
- **The token decides which account you are.** Every access token carries an
  `azp` claim — the clientId of the Auth0 application it was issued to. The
  backend maps `azp` to `REACT_APP` / `ADMIN_PANEL` (via the
  `AUTH0_REACT_APP_CLIENT_IDS` / `AUTH0_ADMIN_PANEL_CLIENT_IDS` env vars) and
  resolves the customer account by the exact `(sub, client)` key. An
  admin-panel token can never act on the web-app account or vice versa. If the
  `azp` is not in either list, the backend falls back to sub-only resolution,
  preferring the `REACT_APP` profile.
- **Onboarding.** On first login the panel calls `POST /onboard-customer` with
  `client: 'ADMIN_PANEL'` (see `src/services/onboardService.ts`). The server
  binds `sub` to the JWT, lets the token's `azp` override the body's `client`,
  and creates the admin-panel account.
- **Domain restriction.** Enforced at two layers. At **login**, an Auth0
  post-login Action (`auth0/post-login-action.js`) denies admin-panel logins
  unless the email is on the allowed domain **and verified** — verification is
  what stops a database-connection signup from claiming a fake on-domain
  address. On the **backend**, admin-panel onboarding is rejected (403) unless
  the email is on the domain configured by `ADMIN_EMAIL_DOMAIN` (default
  `genflowly.com`), and the same domain check runs on every `/api/v1/admin/*`
  request inside `isAdminCustomer`.
- **Admin allowlist.** Domain membership alone does not grant admin rights.
  The server additionally requires the profile email (or customerId) to be on
  an env-var allowlist — either list grants access:

  ```
  ADMIN_EMAILS=alice@genflowly.com,bob@genflowly.com
  ADMIN_CUSTOMER_IDS=CUXXXXXXXXXXXX
  ```

Request flow:

```
Auth0 SPA login (admin-panel clientId)
        │  post-login Action: deny unless verified @genflowly.com
        │  access token: sub = user identity, azp = admin-panel clientId
        ▼
genai-proxy-server auth ("auth0" JWT verify: issuer + audience)
        │  azp → ADMIN_PANEL  (AUTH0_ADMIN_PANEL_CLIENT_IDS)
        ▼
CustomerProfile lookup by (sub, "ADMIN_PANEL") → admin customerId
        │
        ▼
/api/v1/admin/* : requireAdminCustomerId
  = profile email on ADMIN_EMAIL_DOMAIN + on ADMIN_EMAILS allowlist
```

## Setup

### 1. Create the Auth0 application

In the Auth0 dashboard (same tenant as the react app), create a new
**Single Page Application** for the admin panel:

- Allowed Callback URLs / Logout URLs / Web Origins: wherever the panel is
  served (e.g. `http://localhost:3001`).
- No client secret is used anywhere — SPAs are public clients.
- Do **not** reuse the react-app clientId: the whole account separation hinges
  on the two apps having distinct clientIds (distinct `azp` values).

### 2. Install the post-login Action (domain restriction)

In the Auth0 dashboard: **Actions → Library → Create Action** — name it
"Restrict admin panel to genflowly.com", trigger **Login / Post Login**, and
paste [`auth0/post-login-action.js`](auth0/post-login-action.js). In the
editor's **Secrets** panel (🔑) add:

| Key | Value |
|---|---|
| `ADMIN_CLIENT_IDS` | comma-separated admin-panel clientIds, e.g. `<dev-id>,<prod-id>` |
| `ADMIN_EMAIL_DOMAIN` | `genflowly.com` |

**Deploy**, then drag the action into the Login flow (**Actions → Flows →
Login**). Re-deploying an action already in the flow updates it in place.

Caveats: only the applications in `ADMIN_CLIENT_IDS` are affected (react-app
logins are untouched, SSO preserved); if that secret is unset the action
no-ops for every application (fails open), so verify it saved. The backend
re-enforces the same domain plus the `ADMIN_EMAILS` allowlist, so the Action
is the front door, not the only lock.

### 3. Configure this frontend

```bash
cp .env.example .env.local
```

```
VITE_AUTH0_DOMAIN=auth.genflowly.com
VITE_AUTH0_CLIENT_ID=<admin-panel Auth0 clientId>   # NOT the react-app one
VITE_AUTH0_AUDIENCE=https://api-development.genflowly.com
VITE_BACKEND_URL=http://127.0.0.1:8080
```

### 4. Configure the backend

Set both mapping vars **together** (in `genai-proxy-server/.env` for local
docker-compose; as GitHub secrets `AUTH0_REACT_APP_CLIENT_IDS` /
`AUTH0_ADMIN_PANEL_CLIENT_IDS` for deploys — the pipelines forward them):

```
AUTH0_REACT_APP_CLIENT_IDS=<react-app Auth0 clientId(s), comma-separated>
AUTH0_ADMIN_PANEL_CLIENT_IDS=<admin-panel Auth0 clientId(s), comma-separated>
ADMIN_EMAIL_DOMAIN=genflowly.com   # optional, this is the default
ADMIN_EMAILS=...                   # allowlist, see above
```

Restart the server with recreated containers so the env is re-read:

```bash
docker compose up -d --force-recreate app
```

While the vars are unset (or while both apps still share a clientId), all
tokens fall back to sub-only resolution and resolve to the `REACT_APP`
profile — the panel will then operate on the web-app account, so complete this
step before relying on account separation.

### 5. First login

Log out and back in after switching clientIds so a token issued to the new
application (with the new `azp`) replaces any cached one. On first login the
panel onboards the `ADMIN_PANEL` account automatically; the account must then
be on the admin allowlist for `/api/v1/admin/*` to respond.

## Backend endpoints used

All JWT-only (Auth0) and restricted to admins:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/system-api-keys` | Status per vendor (never key material) |
| `POST` | `/api/v1/admin/system-api-keys` | Validate against vendor, then store encrypted |
| `DELETE` | `/api/v1/admin/system-api-keys/{aiVendor}` | Remove a key |

## Run

```bash
npm install
cp .env.example .env.local   # fill in Auth0 + backend URL
npm start                    # http://localhost:3001
```

`npm run build` type-checks and produces a production bundle in `dist/`.
