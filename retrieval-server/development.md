# Retrieval Server — Development Guide

## Observability: metrics & logging

Metric naming, allowed dimensions and the canonical metric list are pinned in the repo-wide conventions doc — see the "Observability" section of `genai-proxy-server/development.md`. This page covers how to emit them from this service.

Use the shared util from `encoding_library.observability` — decorator for the ok/error/duration triple, imperative calls for values produced inside the operation:

```python
from encoding_library.observability import track, count, observe

@track("vector_retrieval", source="retrieve")   # -> vector_retrieval_total + vector_retrieval_duration_seconds
async def _retrieval_impl(...): ...

count("vector_store_chunks_total", len(chunks), data_type="NOTE")
observe("llm_request_duration_seconds", elapsed, vendor=provider)
```

Setup is already done once in `app.py` — `configure_observability(service="retrieval-server", backend="prometheus")` + `setup_logging(...)` — do not repeat it in modules. The Prometheus registry is exposed at `/metrics` (prometheus-fastapi-instrumentator) and scraped by Fly's org Prometheus via the `[metrics]` block in `fly.toml`.

**Swallowed failures must still count.** When an operation degrades instead of raising (graph nodes returning empty results), put `@track` on a raising inner function and catch around the call — a metric that can never record `status=error` is useless for alarming. See `graph/nodes/retrieval.py` / `graph/nodes/web_search.py` for the pattern. Existing degradation counters: `memory_load_failure_total`, `memory_recall_failure_total`, `graph_stale_serve_total`, `stream_zero_tokens_total`, `stream_error_total`, `zilliz_credential_fallback_total`.

**Logging**: emit structured context via `extra={...}` (rendered as JSON fields), not f-string interpolation, for anything a dashboard or Logs Insights query might filter on. Never rely on log-message wording for alarms — that's what the counters are for.

**Request id**: the middleware in `app.py` adopts the proxy's `X-Request-Id` (or mints one) and binds it to the logging contextvar, so every log line of a request carries `request_id` automatically — nothing to do per-module.

**Production logs problems only — and never user content.** Two layers, both keyed off `APP_ENV` (`production` in `fly.production.toml`; the dev Fly app and local machines are development). (1) Level: `app.py` sets WARNING+ in production, INFO in development; an explicit `LOG_LEVEL` env var overrides. (2) Content gate: lines carrying user content — prompts, system prompts/instructions, LLM responses, memories, queries — are gated by `content_logging.py`: wrap whole-line dumps in `if LOG_USER_CONTENT:` and single content fields in `redact(value, limit)`. The gate is independent of level, so content stays out of production logs even under a temporary `LOG_LEVEL=INFO`. When adding a log line, ask: could this contain something a user typed or the model generated for them? If yes, gate it — and never log emails or names at any level. Repo-wide policy: `genai-proxy-server/development.md` → "Logging policy".

## Third-party calls: retry with exponential backoff

Every outbound call to a third-party API MUST go through `encoding_library.utils.retry` (`@retry`, `retry_call`, or a `RetryingProxy`-wrapped client). Each retry emits `retry_attempt_total{operation}`; giving up emits `retry_exhausted_total{operation}`.

- **Milvus/Zilliz**: `get_milvus_client()` already returns a retry-wrapped client — use it, never construct `MilvusClient` directly.
- **Embeddings**: `create_embeddings()` retries internally.
- **HTTP calls**: pass `retry_if=is_transient_http_error` so only connection errors, 429 and 5xx retry — a 401/404 must fail fast. Call `raise_for_status()` *inside* the retried function, or 429/5xx responses won't trigger a retry.
- **LLM chat calls are the exception**: they retry inside the vendor SDKs (`max_retries` in `graph/llm_factory.py`), not through this util — re-issuing a generation from our layer can double-bill when the original request actually succeeded server-side. Same for key validation (SDK-level; auth errors must not retry).
- **boto3 (DynamoDB/S3/KMS)** has its own built-in backoff — don't double-wrap.
- **Voice realtime websockets** are stateful sessions; reconnection is session logic, deliberately not covered by this util.

## Image attachments: any type, any size

Uploads are unrestricted: the proxy accepts any media type (blank → `application/octet-stream`) and any size. The retrieval server makes the bytes acceptable to the LLM vendor at call time. `graph/s3_images.fetch_image_for_llm(s3_key, provider)` reads the S3 object, and `graph/image_normalize.normalize_image` (pure, no S3) returns `(bytes, media_type)`. The result is LRU-cached per `(s3_key, format set)`; the original S3 object is never modified.

- **Sniffed, never trusted.** The format comes from the bytes (Pillow + `pi-heif` for HEIC/HEIF; AVIF, TIFF, BMP, WebP, GIF, ICO, PSD, … via Pillow). The data URL always carries the media type of the bytes actually sent.
- **Passthrough** (bytes untouched, decided from the header without decoding): the format is one the vendor documents (`passthrough_formats_for`: Anthropic/OpenAI JPEG/PNG/GIF/WebP, Gemini JPEG/PNG/WebP, everyone else incl. xAI and LiteLLM-routed vendors JPEG/PNG), the base64 size is within budget, both edges are ≤ the max edge, there's no EXIF rotation, and the image isn't animated. Multi-frame JPEGs (MPO / Ultra HDR) count as plain JPEGs.
- **Otherwise: lossless PNG** (accepted by every vendor). The first frame is decoded, EXIF orientation applied, and the mode normalized to 8-bit L/RGB/RGBA. The ICC profile is kept when it matches the colour space; EXIF (incl. GPS) is dropped. If it is over budget, it is downscaled (LANCZOS) and re-encoded losslessly. The target size comes from a 6×6 tile-mosaic size estimate, so a typical photo needs one full encode. Downscaling stops at a 1568 px long edge (Claude's standard-tier max); only if lossless can't fit there does it fall back to **JPEG q90→50** (alpha flattened onto white).
- **Unusable files fail the turn with a readable message.** These are `ImageNormalizationError` (a `ValueError`) and its subclasses `UnsupportedImageError` (SVG, PDF, camera RAW, video, garbage, truncated) and `ImageTooLargeError`. `streaming.user_facing_llm_error` passes the message through verbatim as `error_type: "attachment_error"`, instead of "The provider returned an error". In history replay (`strict=False`) a failed image degrades to `[attached image unavailable]`.
- **Resource guards** (one process, 1 GB RAM, one shared CPU serves everyone):
  - Pixel limits are checked from the header before decoding: 52 MP, or half that for images with alpha, because resampling premultiplies into a full-size copy.
  - Baseline JPEGs up to 256 MP (Samsung 200 MP = 199.7 MP) decode at 1/2–1/8 scale via `draft()`. Progressive JPEGs over the pixel limit are refused.
  - The source size is checked from S3 `ContentLength` before the body is read.
  - Heavy decode/encode is serialized by a module-level lock.

| Env var | Default | Meaning |
|---|---|---|
| `IMAGE_MAX_BASE64_BYTES` | 5 MiB | Per-image budget on the **base64** string. Anthropic's 5 MB limit on Bedrock/Vertex is measured on base64 (10 MB on the direct API); this is the strictest per-image vendor limit. |
| `IMAGE_MAX_EDGE_PX` | 8000 | Anthropic's max dimension. |
| `IMAGE_MAX_DECODE_PIXELS` | 52,000,000 | Decompression-bomb / OOM guard. Admits iPhone 48 MP (48.8 MP) and 50 MP Android modes. |
| `IMAGE_MAX_SOURCE_BYTES` | 100 MiB | Operational OOM guard, not a product limit. Covers 200 MP JPEGs (~25–60 MB) and 48 MP PNGs (~75 MB). |

Measured on one core (`taskset -c 0`, synthetic photo-like fixtures, median of 3):

| Input | Wall time | Peak RSS growth | Output |
|---|---|---|---|
| 12 MP HEIC | 1.5 s | +93 MB | 2005×1504 lossless PNG |
| 48 MP HEIC | 3.9 s | +336 MB | 2123×1592 |
| 48 MP JPEG | 1.2 s | +88 MB | |
| 200 MP JPEG | 1.6 s | +87 MB | |
| 48 MP PNG (77 MB) | 3.0 s | +252 MB | |
| Rotated 12 MP JPEG | 1.2 s | | upright 1456×1941 |

In-budget JPEG/PNG pass through in under 50 ms.

## Customer-defined tools

A customer's tool is a stored RECORD, not code, so adding one costs a row rather
than a deploy. `graph/tools_runtime.tools_for` is the single seam that resolves
a request's enabled names to tools: built-ins first, then the customer's own.
A built-in always wins a name collision, so nobody can redefine `web_search`.

| Provider | A record is | Interpreter |
|---|---|---|
| `http` | one HTTP call | `graph_tools/providers/http_tool.py` |
| `mcp` | one MCP server, many tools | `graph_tools/providers/mcp_tool.py` |

Two properties carry the security, because a tool's arguments are written by the
model and a user can steer the model with pasted text.

**The destination is pinned when the tool is defined.** Placeholders are rejected
in the URL scheme and host; only the path, query, headers and body may be
templated, and the assembled origin is re-checked before the call. A
prompt-injected argument can change what a request says, never where it goes.

**Substitution is not evaluation.** No expression language, no second pass. A
value that is itself `{{credential.api_key}}` is not re-substituted, and a
placeholder naming an unknown key is an error rather than an empty string.

Credentials never enter graph state (the durable runtime checkpoints it) and
never a process env var (one event loop serves every tenant). They are resolved
per run by `graph/tool_credentials.py` — a sibling of `graph/credentials.py`,
same rules — and reach a tool only through `ToolContext.secrets`.

### Endpoints

| Endpoint | Does | Writes |
|---|---|---|
| `POST /tools/dry-run` | run one tool definition, returning the outbound request with credentials masked, the raw response, and the exact string the model would see | nothing |
| `POST /connectors/openapi/preview` | fetch an OpenAPI spec and return the tools it would produce | nothing |
| `POST /connectors/mcp/discover` | connect to an MCP server and list the tools it offers, for the user to approve | nothing |

All three are read-only by design: they return proposals the proxy then saves.
The two connector endpoints take a URL the USER typed, which is why they live
here rather than in the proxy — this is where the SSRF-hardened client
(`graph_tools/providers/safe_client.py`) is. That module refuses non-https
destinations, any host resolving to loopback/private/link-local/reserved space,
redirects, unbounded time or size, and caller-set transport headers. Its one
known gap, DNS rebinding between validation and connection, is documented in the
module rather than left to be discovered.

A tool stays `draft` until a dry run succeeds. Only `active` records are ever
bound, and a customer-defined tool is never enabled implicitly — see
`_enabled_builtin_tools` in `routes/retrieve.py`, whose no-config fallback
covers built-ins only.

## Agent-loop graphs

The same engine runs two graph shapes. A **pipeline** graph wires retrieval
decisions into the topology (query → RETRIEVAL → rank → generate): fixed
latency, predictable cost, retrieval on every turn. An **agent** graph is the
degenerate two-node form — response generator cycling with TOOL_EXECUTOR until
the model stops calling tools — where retrieval, search rounds, and when to
answer are the model's per-turn decisions. Template (topology, node configs,
loop-budget rationale): `graph/templates/agent_loop.json`; it is published as
ordinary `CustomerGraphs`/`CustomerGraphNodes` records, so the request API,
streaming, and the durable /runs path treat both shapes identically. To
publish it fleet-wide, use the admin panel's Agents page ("Publish Agent
Loop" → proxy `POST /admin/system-agents`, a System-owned NON-default agent
every customer can select); the TS mirror of the template lives in
`admin-panel/src/constants/agentTemplates.ts` — keep the two in sync.

The bridge between the shapes is `search_knowledge_base`
(`graph/knowledge_tool.py`): the RETRIEVAL node's exact search core
(`graph.nodes.retrieval.search_knowledge`) exposed as a built-in tool, so the
model writes its own queries and can refine them after reading results —
multi-hop retrieval a feed-forward pipeline cannot express. It is
**explicit-only**: excluded from the all-built-ins enablement default
(`_EXPLICIT_ONLY_TOOLS` in `graph/tools_runtime.py`) so an existing pipeline
graph with an unscoped TOOL_EXECUTOR node never starts retrieving twice; a
TOOL_EXECUTOR config must name it in `"tools"`.

A turn's tool calls execute **concurrently** (`asyncio.gather` in
`graph/nodes/tool_executor.py`) with per-call error isolation; rendering and
citation numbering stay sequential in the model's call order, so
`loop_messages` and `[n]` source indices are deterministic regardless of
completion order.

### The harness

The agent harness is a **thin code kernel + prompts-as-data**. The kernel
(own it, nothing external to track):

| Piece | Where | What |
|---|---|---|
| `write_todos` | `graph_tools/tools/write_todos.py` | the agent's plan as a checklist; full-list replace; current list lands in `scratch["todos"]`, rides the TOOL_EXECUTOR `thinking_step` (`todos` field) and is persisted by the proxy with the turn's thinking JSON |
| scratch FS | `graph/fs_tools.py` | `fs_write`/`fs_read`/`fs_list` on run-scoped S3 keys `customers/{cid}/agent-fs/{namespace}/…`; one namespace per request, pinned in scratch, shared down the subagent tree |
| result spill | `tool_executor.py` | tool results over `max_tool_result_chars` (default 8k) spill: full content → scratch FS, head+tail excerpt + fs path → `loop_messages`; messages are never dropped, `tool_call_id` pairing never breaks |
| compaction | `llm_node.py` | past `compaction_threshold_tokens` (default 40k) older loop rounds fold into an LLM-written summary (durable-step billed, `operation=compaction`), pinned in `scratch["compaction"]`; whole rounds fold as a unit so pairing stays vendor-legal; a failed summarization degrades to clipping and retries next iteration |
| turn budget | `llm_node.py` | past `max_turn_tokens` the generator binds no tools and must answer with what it has |
| `spawn_agent` | `graph/spawn_tool.py` + `graph/subagent.py` | child agent loops (same generator⇄executor engine): context-isolated, depth-capped (2), usage merged back, artifacts forwarded, child trace in the call's `details`; concurrent per turn on /retrieve, sequential on durable /runs (DBOS step-order determinism) |

Tool-side contracts: `ToolResult.state_patch` (merged into scratch),
`ToolResult.usage` (joins the run's usage channel), `ToolResult.details`
(trace-only), `ToolContext.runtime` (host-injected fs prefix / depth /
subagent profiles / spawn callable).

**Prompts are data.** The harness prompt is `harness_prompt` on the generator
node config (or `harness_instruction_id` → a versioned instruction record,
resolved per request; inline text is the fallback), prepended before the
customer persona. Subagent profiles (`subagents` on the TOOL_EXECUTOR config:
`{name, description, prompt|instruction_id, tools, model?, max_turn_tokens?}`)
are listed in the model's system prompt for description-driven dispatch; the
built-in `general` profile always exists. Updating any of it is a DDB edit
with ~60s propagation, not a deploy.

**Evals, not parity.** `evals/` is the behavioral suite (multi-hop KB, don't-
retrieve chitchat, long research loop, delegation, compaction survival,
budget exhaustion) run against a live server — see `evals/README.md`. Fold
ideas from Claude Code / Deep Agents release notes into the prompt records on
a periodic review; the evals decide whether they helped on OUR workloads.

Planned next: a `run_graph` tool exposing a pipeline graph as one callable
step for agents; an AGENT node type so pipelines can embed a bounded agent
loop as one node; concurrent spawn on the durable path (step names keyed by
agent path); first-class agent-path fields on streamed events.

## Durable agentic runs (planned)

Full design and rationale: `DURABLE_AGENTS_DBOS_PLAN.md`. Goal: evolve this service from a
stateless-per-call graph runner into a durable runtime — runs that survive process crash/redeploy,
in-graph human-in-the-loop, exactly-once LLM steps, reattachable streams — using DBOS (durable
workflows, MIT-licensed library) plus a LangGraph Postgres checkpointer on a managed Supabase
database. No new always-on infra on Fly.

| Phase | What | Where |
|---|---|---|
| P0 | Spike: prove DBOS + checkpointer + Supabase locally (crash-resume, reattach, `interrupt()`) | here, throwaway branch |
| **P1a** | Secrets out of `RetrievalState` — resolve `llm_credentials` from DynamoDB by `customer_id` at call time instead of carrying them in graph state | **here — start here, independent of everything else** |
| P1b | Extract the proxy's SSE→chunk parser into a shared function (reused by the new run-stream reattach path later) | genai-proxy-server |
| P1c | Durable `/runs` path — checkpointer-backed compile variant, a DBOS workflow driving `astream_events`, a reattach channel, `POST /runs` / `GET /runs/{id}/stream` / `POST /runs/{id}/cancel`. Ships dark (unused). | here |
| P1d | Proxy wires one flow to `/runs` behind a flag | genai-proxy-server |
| P2 | Exactly-once LLM step (wrap the vendor call as a `@DBOS.step()`) + in-graph `interrupt()`/resume for HITL and client-fulfilled tools | both |
| P3 | Queue concurrency/retry tuning, run inspection, checkpoint/event TTL, cron | both |

**Start with P1a.** It's a pure security refactor, ships independently, and is a hard prerequisite
for checkpointing (state that will be persisted to Postgres must never carry secrets). New
`graph/credentials.py`: resolve creds by `customer_id` from the `CustomerVendorApiKeys` DynamoDB
table (PK=`customerId`, SK=`aiVendor`) and KMS-decrypt (no explicit key ARN needed — it's embedded
in the ciphertext), memoized per run so a looping graph does one DDB+KMS round-trip, not one per
node. Mirrors the proxy's own `CustomerCredentialsRepository`/`KMSProvider` path; needs
`dynamodb:GetItem` on that table + `kms:Decrypt` granted to this service's IAM role.

**Supabase connection mode matters.** Use the Supabase **session pooler** URL (port 5432,
`sslmode=require`) for `DATABASE_URL` — never the **transaction pooler** (6543), which breaks
advisory locks. P0 confirmed `LISTEN/NOTIFY` does **not** work over Supabase's pooler in any mode,
so DBOS runs with `use_listen_notify=False` (it polls) and the reattach channel polls the events
table; neither needs NOTIFY. DBOS keeps its tables in a schema via `dbos_system_schema`, so the one
Supabase `postgres` database is sufficient.

**Required config — `DATABASE_URL` (the Supabase session-pooler connection string).** Without it
the server starts normally and durable `/runs` is simply inactive; with it, durable runs are
enabled.

- **Local dev:** put it in `retrieval-server/.env.local` (gitignored — see `.env.example`).
- **Deployed:** it's a **Fly secret on the `genai-retrieval-server-<stage>` app** (note: the CI app
  name is `genai-retrieval-server-<stage>`, not the `retrieval-server` in `fly.toml`). Set it via
  the Fly dashboard or `flyctl secrets set --app genai-retrieval-server-<stage> DATABASE_URL=…`.
  CI (`dev`/`prod-proxy-server.yml`, "Deploy Retrieval Server" step) also sets it from an
  environment-scoped **`DATABASE_URL` GitHub Actions secret** if that secret exists — so add it per
  environment (dev/prod point at different Supabase projects) to keep deploys reproducible.
