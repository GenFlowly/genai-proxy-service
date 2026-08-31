# genai-proxy-server

Ktor (Kotlin) API server for GenFlowly. It is the authenticated front door for all
clients (web app, iOS app, developer API keys): it owns customers, conversations,
instructions and vendor API keys, and delegates all AI work to the
**retrieval-server** (Python/FastAPI, LangGraph) over HTTP/WebSocket.

```
clients (web / iOS / API keys)
        │  Auth0 JWT or gfy_ developer key
        ▼
genai-proxy-server (Ktor, this repo)          DynamoDB (profiles, conversations,
        │  RETRIEVAL_SERVER_URL               messages, instructions, vendor keys)
        ▼
retrieval-server (FastAPI + LangGraph)
        │
        ▼
AI vendors (OpenAI, Anthropic, Gemini) — customer-owned API keys
```

## Architecture

### How model lists are produced

Model listing is **catalog-based**, not fetched live from vendors. The
retrieval-server's `POST /models` reads [LiteLLM's model catalog](https://docs.litellm.ai/docs/)
(`litellm.models_by_provider` + `litellm.model_cost`), which carries per-model
capability metadata the vendors' own list APIs lack.

- `POST /api/v1/models` — all models for the requested vendors
  (`AIModelsService.getModelsForVendors`, capability `all`, unfiltered).
- `POST /api/v1/voice/models` — realtime voice models only (capability `voice`).
  A model qualifies when the catalog marks it `mode: "realtime"` or lists
  `/v1/realtime` in `supported_endpoints`. Anthropic has no realtime voice API,
  so `CLAUDE` always returns an empty list here.

The proxy only asks for vendors the customer has a stored API key for; vendors
without a key return an empty list. Because the catalog never touches the
vendor, **API key validation is separate**: storing a key
(`POST /api/v1/store-api-key`) calls the retrieval-server's `POST /validate-key`,
which makes one cheap authenticated list call to the vendor and reports
valid/invalid. New models appear when the retrieval-server's `litellm`
dependency is updated.

### How text generation works

`POST /api/v1/generate-text` and `POST /api/v1/generate-text-stream`
(`GenerationOrchestrator` → `RetrievalServerClient`):

1. **Resolve context** — the instruction (persona) version becomes the system
   prompt; the conversation is fetched or created (with OWNER/EDIT write-access
   checks); the user message is persisted with a deterministic ID; the message
   thread is loaded as history.
2. **Delegate to retrieval-server** — `POST /retrieve` with the prompt, history,
   system prompt, provider/model and the customer's vendor API key
   (`llm_credentials`, fetched from DDB and decrypted via KMS; never exposed to
   clients). With `agentic=true` the retrieval-server runs the customer's
   LangGraph agent graph (query analysis, retrieval/RAG, ranking, response
   generation — nodes configured in DDB); with `agentic=false` it runs a single
   direct-LLM node. LangChain chat wrappers (`ChatOpenAI` / `ChatAnthropic` /
   `ChatGoogleGenerativeAI`) are built per request by `graph/llm_factory.py`.
3. **Stream + persist** — the streaming variant relays SSE chunks (content,
   thinking, thinking-duration, usage) as JSON lines; conversation/message IDs
   are returned in `X-Conversation-Id` / `X-Message-Id` /
   `X-Response-Message-Id` headers. On completion the assistant message is
   persisted with token usage (`inputTokens`, `outputTokens`, `totalTokens`,
   `tokensReadFromCache`).

### How voice conversations work

`WS /api/v1/voice/session` is the voice counterpart of generate-text-stream:
same auth, same instruction system, same conversation store — voice exchanges
appear in history exactly like text messages.

The proxy is an **authenticated relay**:

```
client ──WS──> genai-proxy-server ──WS──> retrieval-server /voice ──WS──> vendor
               resolves customer,          provider adapters:              OpenAI Realtime API
               instruction, conversation;  openai_realtime / gemini_live   or Gemini Live API
               injects vendor API key;
               persists transcripts+usage
```

1. The client sends a `session.init` frame shaped like a GenerateText request
   (`aiConfig {aiVendor, model, maxTokens}`, optional
   `prompt {instructionId, instructionVersion}`, optional `conversationId`,
   `client`, `agentic`, optional `voice`). Browsers can pass the Auth0 JWT as an
   `access_token` query parameter (WebSockets cannot set headers).
2. The proxy resolves the customer, instruction and conversation, loads prior
   messages, injects `customer_id` + `llm_credentials` server-side (dropping any
   client-supplied values) and forwards the enriched init to the
   retrieval-server. The client receives
   `{"type":"session.created","conversationId":...}`.
3. The retrieval-server connects a provider adapter — **OpenAI Realtime API**
   (WebSocket, PCM16 24 kHz in/out) or **Gemini Live API** (`google-genai` SDK,
   PCM16 16 kHz in / 24 kHz out) — seeds the conversation history, and exposes
   the customer's LangGraph graph to the voice model as a
   `search_knowledge_base` **tool** (react-voice-agent pattern): the voice model
   handles the audio conversation and calls the graph for grounded answers.
4. Events flow back as JSON frames: `session.ready` (with required audio sample
   rates), `output_audio.delta`, `transcript.delta`/`transcript.done`,
   `tool.started`/`tool.completed`, `usage`, `interrupted`, `error`. The full
   protocol is documented in `retrieval-server/voice/session.py`.
5. The proxy persists every `transcript.done` as a user/assistant `Message`
   chained onto the conversation. Adapters emit each turn's `usage` event
   *before* the assistant transcript, so token usage (input, output, cache,
   total) lands on the assistant message — same fields as text generation.

Voice model ids come from `POST /api/v1/voice/models`. Clients must resample
audio to the rates announced in `session.ready` (OpenAI: 24 kHz in; Gemini:
16 kHz in; both 24 kHz out).

## API documentation

- `GET /api.json` — generated OpenAPI 3 specification
- `GET /docs` — customer-facing API docs (Scalar)
- `GET /swagger` — Swagger UI

REST endpoints are documented inline with their routes (smiley4 ktor-openapi).
The voice session WebSocket cannot be described by OpenAPI; its contract lives
in this README and `retrieval-server/voice/session.py`.

## Configuration

| Env var | Purpose |
|---|---|
| `AUTH0_SPA_DOMAIN` | Auth0 tenant domain (JWT issuer) |
| `AUTH0_API_AUDIENCE` | Expected JWT audience |
| `RETRIEVAL_SERVER_URL` | Base URL of the retrieval-server (default `http://retrieval-server:5001`) |
| `AWS_REGION` | DynamoDB / KMS / Lambda region (default `us-east-1`) |

## Building & Running

| Task                                    | Description                                                          |
|-----------------------------------------|----------------------------------------------------------------------|
| `./gradlew test`                        | Run the tests                                                        |
| `./gradlew build`                       | Build everything                                                     |
| `./gradlew buildFatJar`                 | Build an executable JAR of the server with all dependencies included |
| `./gradlew buildImage`                  | Build the docker image to use with the fat JAR                       |
| `./gradlew publishImageToLocalRegistry` | Publish the docker image locally                                     |
| `./gradlew run`                         | Run the server                                                       |
| `./gradlew runDocker`                   | Run using the local docker image                                     |

If the server starts successfully, you'll see the following output:

```
2024-12-04 14:32:45.584 [main] INFO  Application - Application started in 0.303 seconds.
2024-12-04 14:32:45.682 [main] INFO  Application - Responding at http://0.0.0.0:8080
```
