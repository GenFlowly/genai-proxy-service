# Realtime Voice Example (Next.js)

A minimal browser app for live speech-to-speech conversations with OpenAI
(or Gemini) **through the GenFlowly proxy server** — the voice counterpart of
`generate-text-stream`. It exercises two endpoints:

- `POST /api/v1/voice/models` — lists the realtime voice models available to
  your customer account (based on the vendor API keys you have stored)
- `WS /api/v1/voice/session` — the realtime voice WebSocket: mic audio up,
  synthesized audio + transcripts + token usage down. Transcripts are
  persisted to a conversation exactly like text messages.

## Architecture

```
browser ──WS /api/voice/relay──> Next.js server (server.js) ──WS──> genai-proxy-server ──> retrieval-server ──> OpenAI Realtime / Gemini Live
        mic PCM16 up,            adds Authorization:                resolves customer, key,
        audio/transcripts down   Bearer gfy_...                     conversation; persists transcripts
```

The Next.js server relays the WebSocket (and the `voice/models` call) so your
developer API key stays server-side. This is also required for API-key auth:
browsers cannot set headers on WebSocket connections, and the proxy accepts
`gfy_` keys only in the `Authorization` header (the `access_token` query
parameter fallback is for Auth0 JWTs).

## Setup

1. Have the genai-proxy-server running (default `http://127.0.0.1:8080`) with
   an OpenAI API key stored for your customer account (`POST /api/v1/store-api-key`
   or the web app) — the voice models list is derived from your stored keys.
2. Create a developer API key in the web app under **Settings → Developer**.
3. Configure and run:

```bash
cd examples/realtime-voice-app
cp .env.example .env.local   # then paste your gfy_... key
npm install
npm run dev                  # http://localhost:3000
```

Pick a model (e.g. an OpenAI `gpt-realtime` model), press **Start talking**,
and allow microphone access. Toggle **agentic** to let the voice model call
your knowledge base (agent graph) as a tool.

## How the client works

- **Handshake** — on connect the app sends `session.init` with
  `aiConfig {aiVendor, model, maxTokens}`, optional `voice`, `client: "web"`
  and `agentic`. The server answers `session.created` (conversationId) and
  `session.ready` (required audio sample rates).
- **Microphone** (`lib/audio.ts`, `public/pcm-recorder-worklet.js`) — an
  AudioWorklet captures mono audio at the hardware rate, a streaming linear
  resampler converts it to the announced `input_rate` (OpenAI 24 kHz,
  Gemini 16 kHz), and chunks are sent as base64 PCM16 `input_audio.append`
  frames.
- **Playback** — `output_audio.delta` chunks (PCM16 at `output_rate`, 24 kHz)
  are scheduled gaplessly on a Web Audio timeline. An `interrupted` event
  (user barge-in) stops playback and drops the queue immediately.
- **Transcripts** — `transcript.delta` frames stream partial text per role;
  `transcript.done` carries the final text (which the proxy also persists to
  the conversation). `usage` frames report per-turn token counts.

Full protocol reference: the genai-proxy-server README and the
`/api/v1/voice/session` entry in the proxy's `/docs`.

## Troubleshooting

- **"GENFLOWLY_API_KEY is not set"** — copy `.env.example` to `.env.local`
  and restart `npm run dev`.
- **Model dropdown says "unavailable"** — the proxy is unreachable or the key
  is invalid/revoked; the error box shows the upstream status.
- **Empty model list** — your customer account has no stored OpenAI/Gemini
  vendor API key, or the stored vendor has no realtime models.
- **No microphone prompt** — browsers only expose the mic on secure contexts;
  `http://localhost` qualifies, a LAN IP does not.
