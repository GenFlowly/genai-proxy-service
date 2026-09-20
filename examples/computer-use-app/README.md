# Claude Computer Use Example (Vite + React + Playwright)

A browser app demonstrating the genai-proxy-server's **Claude computer-use tool**
driving a **real browser**: Claude looks at screenshots of a live Chromium page,
decides on actions (navigate, click, type, scroll), the app executes them with
Playwright and sends a fresh screenshot back, until the task is done.

The page is a horizontal split:

- **Top — the screen.** A live view of the Playwright Chromium page (polled
  screenshots + a read-only address bar), plus a filmstrip of every screenshot
  that was actually sent to Claude.
- **Bottom — the chat.** The shared `ConversationWidget` from
  `@genflowly/component-library` (the same conversation surface as the
  GenFlowly web app), wired to the computer-use loop. Each executed action
  shows up as a step in the response card's "Thinking" trace.

Exercises `POST /api/v1/generate-text-stream` (NDJSON streaming, `tc` tool-call
chunks, `toolResults` continuations) and `POST /api/v1/models`.

## Architecture

```
                    browser tab (React)
   ┌───────────────────────────────────────────────┐
   │  ConversationWidget (chat)   LiveScreen (img)  │
   └───────────────┬───────────────────┬───────────┘
                   │ /api/v1/*          │ /computer/*
                   ▼                    ▼
        Vite dev server: proxy + Playwright plugin (Node)
                   │                    │
   (+ Authorization: Bearer gfy_...)    │ owns one Chromium page
                   ▼                    ▼
          genai-proxy-server      Playwright → real websites
                   │
                   ▼
          retrieval-server → Anthropic
```

The loop, per user turn:

1. `POST /generate-text-stream` declaring the `computer` tool plus `navigate`
   and `go_back` **function tools** (they mix freely with the native tool).
2. Stream text into the message; a `{"t":"tc"}` chunk delivers tool calls.
3. Dispatch each call: `navigate`/`go_back` → the Playwright page; `computer`
   actions → `page.mouse` / `page.keyboard` / `page.screenshot()`. Screenshots
   ride back inline as base64 PNG.
4. Continue the same endpoint with an empty prompt + `selectedResponseId` until
   Claude answers with text only (client cap: 30 iterations).

**Why a `navigate` function tool?** Playwright screenshots only the page
content, not browser chrome — so there's no address bar for Claude to click.
The `navigate(url)` function tool lets it open any site directly. Everything
else (clicking links, filling fields, scrolling) goes through the native
`computer` tool against the live page.

**Key handling.** The developer API key stays server-side: the Vite dev server
attaches `Authorization: Bearer <GENFLOWLY_API_KEY>` to proxied `/api` requests
(`vite.config.ts`). No `VITE_` prefix, so it's never bundled into browser code —
same rule as `examples/realtime-voice-app`.

**Computer tool versions.** Native tool types are Claude-only and versioned:
Claude ≤ 4.5 wants `computer_20250124`, Claude ≥ 4.6 wants `computer_20251124`
(with the `computer-use-2025-11-24` beta, passed via the tool's
`anthropic_beta` option, which the retrieval-server forwards as the beta
header). The app sends the modern version and falls back to the legacy one
per-model if Anthropic returns a 400. `agentic: false` skips the agent graph
for pure GUI-driving turns.

## Setup

1. Run the genai-proxy-server locally at `http://127.0.0.1:8080`
   (`docker compose up` in the repo root) with an Anthropic key stored for
   your account (web app → Settings → LLM API Keys).
2. Create a developer API key (`gfy_...`) in the web app under
   Settings → Developer.
3. Then:

```bash
cd examples/computer-use-app
cp .env.example .env.local     # paste your gfy_... key
npm install
npx playwright install chromium  # one-time: download the Chromium binary
npm run dev                    # http://localhost:3006
```

> `@genflowly/component-library` resolves from GitHub Packages — you need the
> usual `~/.npmrc` with `@genflowly:registry=https://npm.pkg.github.com/` and a
> token with `read:packages`. Until the version carrying `ConversationWidget`
> (>= 0.1.52) is published, install it from a local build:
> `cd ../../../component-library && npm run build && npm pack`, then
> `npm install <path to the .tgz> --no-save` here.

Set `PLAYWRIGHT_HEADED=1` in `.env.local` to watch the Chromium window as
Claude drives it; the default is headless.

Try prompts like:

- *“Go to example.com and tell me the main heading.”*
- *“Open news.ycombinator.com and summarize the top 3 stories.”*
- *“Go to dol.wa.gov and start a vehicle tab renewal — ask me for details when you need them.”*

## What it will and won't do for you

This drives a **real browser**, so Claude can genuinely navigate sites and fill
in fields. But for anything sensitive — entering a PIN, card number, or other
personal details, clicking a final **pay/submit**, or solving a **CAPTCHA** — a
human should take over. The demo executes whatever actions the model returns;
it does not add its own guardrails, so don't point it at a task you wouldn't
want automated, and stay in the loop for irreversible steps. For something like
a car-tab renewal the realistic outcome is *assisted* completion: Claude does
the navigation and form legwork and asks you for the sensitive bits.

## Files

- `vite.config.ts` — the `/api` proxy + the Playwright surface plugin
  (`/computer/execute`, `/computer/navigate`, `/computer/back`,
  `/computer/screenshot`).
- `playwright/surface.ts` — Node controller for the Chromium page: maps
  computer-use actions onto Playwright, translates xdotool-style key names, and
  serializes all page operations through a mutex.
- `src/ComputerUseProvider.tsx` — the computer-use loop; injects the widget's
  conversation API and dispatches tool calls to the surface.
- `src/computer/playwrightSurface.ts` — browser-side client for `/computer/*`.
- `src/computer/LiveScreen.tsx` — the polled live view of the page.
- `src/App.tsx` — the split layout, model picker, filmstrip, and chat.

## Reusing the conversation widget

`ConversationWidget` is presentation-only; the host injects everything through
`ConversationWidgetProvider`:

- `conversation` — the block list + `generateResponsesStream` (here: the
  computer-use loop) + stop/selection handlers,
- `auth` — identity + per-vendor key statuses (enables the Generate button),
- `services` — optional integrations; this demo only injects
  `getVendorDisplayName`, so attachment upload and learned-facts UI stay
  hidden automatically,
- `showToast` / `layout`.

## Troubleshooting

- **“Browser not ready”** on the live screen, or `/computer/*` 500s: the
  Chromium binary isn't installed — run `npx playwright install chromium`.
- **“proxy unreachable — check .env.local”** in the header: the dev-server
  proxy can't reach `GENFLOWLY_PROXY_URL`, or the request failed auth. Verify
  the proxy server is up (`curl http://127.0.0.1:8080/health`) and the
  `gfy_...` key is valid.
- **HTTP 401/403 on generate**: the `gfy_` key was revoked or never set —
  recreate it under Settings → Developer and update `.env.local`.
- **A site shows a CAPTCHA or bot wall**: expected on some sites — Claude
  can't (and shouldn't) solve those; take over manually.
- **Model dropdown falls back to a text input**: `POST /api/v1/models`
  returned no Claude models — store an Anthropic API key for your account
  first.
