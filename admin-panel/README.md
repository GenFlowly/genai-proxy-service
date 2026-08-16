# Admin Panel

Internal admin tool for genai-proxy-server. Currently manages the **system-wide
AI vendor API keys** (OpenAI / Claude / Gemini) stored KMS-encrypted in the
`SystemVendorApiKeys` DynamoDB table (PK = `aiVendor`, so server-side lookup is
a single O(1) `GetItem`).

## Backend endpoints used

All JWT-only (Auth0) and restricted to admins:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/system-api-keys` | Status per vendor (never key material) |
| `POST` | `/api/v1/admin/system-api-keys` | Validate against vendor, then store encrypted |
| `DELETE` | `/api/v1/admin/system-api-keys/{aiVendor}` | Remove a key |

Admin access is controlled on the server by env vars (either list grants access):

```
ADMIN_EMAILS=alice@example.com,bob@example.com
ADMIN_CUSTOMER_IDS=CUXXXXXXXXXXXX
```

## Run

```bash
npm install
cp .env.example .env.local   # fill in Auth0 + backend URL
npm start                    # http://localhost:3001
```

`npm run build` type-checks and produces a production bundle in `dist/`.
