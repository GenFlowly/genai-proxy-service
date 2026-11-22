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

**Swallowed failures must still count.** When an operation degrades instead of raising (graph nodes returning empty results), put `@track` on a raising inner function and catch around the call — a metric that can never record `status=error` is useless for alarming. See `graph/nodes/retrieval.py` / `graph/nodes/web_search.py` for the pattern. Existing degradation counters: `memory_load_failure_total`, `memory_recall_failure_total`, `graph_stale_serve_total`, `stream_zero_tokens_total`, `stream_error_total`, `vector_db_not_configured_total`.

**Logging**: emit structured context via `extra={...}` (rendered as JSON fields), not f-string interpolation, for anything a dashboard or Logs Insights query might filter on. Never rely on log-message wording for alarms — that's what the counters are for.

**Request id**: the middleware in `app.py` adopts the proxy's `X-Request-Id` (or mints one) and binds it to the logging contextvar, so every log line of a request carries `request_id` automatically — nothing to do per-module.

**Production logs problems only — and never user content.** Two layers, both keyed off `APP_ENV` (`production` in `fly.production.toml`; the dev Fly app and local machines are development). (1) Level: `app.py` sets WARNING+ in production, INFO in development; an explicit `LOG_LEVEL` env var overrides. (2) Content gate: lines carrying user content — prompts, system prompts/instructions, LLM responses, memories, queries — are gated by `content_logging.py`: wrap whole-line dumps in `if LOG_USER_CONTENT:` and single content fields in `redact(value, limit)`. The gate is independent of level, so content stays out of production logs even under a temporary `LOG_LEVEL=INFO`. When adding a log line, ask: could this contain something a user typed or the model generated for them? If yes, gate it — and never log emails or names at any level. Repo-wide policy: `genai-proxy-server/development.md` → "Logging policy".

## Per-message lookup pool (multi-model turns)

A turn with N selected models is N independent graph runs of the same user message, each free to call `web_search`. `graph/lookup_pool.py` makes them fetch once: the proxy sends the user message id as `turn_id` on `/retrieve` and `/runs` (null on regenerate and for internal generations), the executor keys the pool by `(turn_id, tool)`, and a run's **first** call to a `shareable` tool is served from the results its siblings already fetched — or are fetching, the waiter blocks on the in-flight call — instead of running. Later calls from that run execute normally and join the pool ("refine and retry" still works), and an identical query is never fetched twice within a turn by any run. Only results that carry sources are shared; a failed or empty lookup makes the waiter fall back to its own call.

- Opt a tool in with `shareable = True` on the `GraphTool` (today: `web_search`). It must be a pure lookup — result determined by its arguments, no side effects.
- The run identity inside the pool is the scratch `fs_namespace`, so subagents count as their parent's run.
- The per-run search budget (`max_web_searches`, hard cap) is unchanged and still counts a pooled call as issued — the pool only ever removes provider calls, never adds any.
- State is in-process (`BoundedCache`, 10-minute TTL); with more than one retrieval machine, siblings landing on different machines simply search as before.
- Metrics: `lookup_pool_total{tool,status}` (outcomes above), `lookup_pool_wait_duration_seconds{tool}`, and `web_search_total` now counts only calls that reached Tavily. Backend Services dashboard → "Web search, tools, streaming, voice" row: *Web search*, *Web search pool*, *Searches avoided 24h*.

## Activity log (the thinking panel's data)

Every turn streams an activity log next to its content: `{"activity": <event>}` from `stream_events_dicts`, relayed by the proxy as the `{"t":"ac","v":<event>}` NDJSON frame and persisted, in stream order, as `Message.activityJson`. The response card's thinking panel (component library `ActivityPanel`, iOS `ActivityViews.swift`) renders nothing else.

- **One module.** `activity/` is the only code that knows the wire shape: `schema.py` (contract v2, builders, `validate`), `recorder.py` (LangGraph `astream_events` → events; one `ActivityRecorder` per turn, `pause`/`resume` around human-input waits on `/runs`), `facts.py` (`report_call`, a LangGraph custom event a node sends when one tool call finishes), `legacy.py` (v1 `thinkingStepsJson` → v2, used by the one-off history migration).
- **Nodes record facts, never wording.** The tool executor puts each call's id, order, budget mode (`run` / `note` / `skip` / `exhausted`), duration, result count, result excerpt and numbered sources (with `favicon` and `published_date`) on its trace entry, plus `budget: {used, max}`; LLM nodes keep their prompt and response excerpts. Titles, phases and beats are decided by the clients' reducers.
- **Events:** `turn.start`, `step.start`, `step.progress` (a streaming llm step's first text), `step.call` (one tool call finished), `step.end` (kind `memory` / `llm` / `tools` / `input`), `turn.end` (with `cited`, the source indices the final answer cites). `at` is milliseconds since the turn started; clients order by array position.
- **The fixtures are the contract.** `tests/activity_scenarios.py` scripts turns as LangGraph events on a fake clock; `tests/fixtures/activity/*.json` are the logs the recorder writes from them. The component library and the iOS test bundle keep byte-identical copies and test their reducers against them. A deliberate contract change: `REGENERATE_ACTIVITY_FIXTURES=1 .venv/bin/python -m unittest tests.test_activity_recorder`, then copy the files to both clients.
- **Privacy:** memory texts, developer excerpts and subagent traces in the log belong to the turn's author; the proxy strips them for every other viewer (`MemoryRedaction.kt`).
- **Tool schemas** ask for a required `purpose` (one sentence for the user: what the call should establish). The tools ignore it and the lookup pool leaves it out of its dedupe key.

## Third-party calls: retry with exponential backoff

Every outbound call to a third-party API MUST go through `encoding_library.utils.retry` (`@retry`, `retry_call`, or a `RetryingProxy`-wrapped client). Each retry emits `retry_attempt_total{operation}`; giving up emits `retry_exhausted_total{operation}`.

- **Milvus/Zilliz**: `get_milvus_client()` already returns a retry-wrapped client — use it, never construct `MilvusClient` directly.
- **Embeddings**: `create_embeddings()` retries internally.
- **HTTP calls**: pass `retry_if=is_transient_http_error` so only connection errors, 429 and 5xx retry — a 401/404 must fail fast. Call `raise_for_status()` *inside* the retried function, or 429/5xx responses won't trigger a retry.
- **LLM chat calls are the exception**: they retry inside the vendor SDKs (`max_retries` in `graph/llm_factory.py`), not through this util — re-issuing a generation from our layer can double-bill when the original request actually succeeded server-side. Same for key validation (SDK-level; auth errors must not retry).
- **boto3 (DynamoDB/S3/KMS)** has its own built-in backoff — don't double-wrap.
- **Voice realtime websockets** are stateful sessions; reconnection is session logic, deliberately not covered by this util.

## Image attachments: any type, any size

Uploads are unrestricted: the proxy accepts any image type (blank, non-image or SVG declarations are stored as `application/octet-stream`) and any size. The retrieval server makes the bytes acceptable to the LLM vendor at call time. `graph/s3_images.image_for_llm(s3_key, limits)` reads the S3 object and runs `graph/image_normalize.normalize_image` (pure, no S3), returning `(base64, media_type)`. The original S3 object is never modified.

- **Sniffed, never trusted.** The format comes from the bytes (Pillow + `pi-heif` for HEIC/HEIF). Only common formats are opened at all: JPEG (incl. MPO), PNG, GIF, WebP, HEIF/HEIC, AVIF, TIFF, BMP, PSD (merged composite), JPEG 2000, TGA, PPM, QOI. Pillow's other decoders (ICO/ICNS decode inside `open()`, FITS/BLP decode in Python loops, EPS runs Ghostscript) are refused, with the format named and an "export it as PNG or JPEG" hint. The data URL always carries the media type of the bytes actually sent.
- **Limits are per request.** Every image in a request (current turn, replayed history, Claude tool results) shares the vendor's request limit. `llm_node.request_image_limits` counts them, and `image_normalize.limits_for_request(provider, count)` gives each an even share, rounded down to a tier (5, 4, 3, 2.5, 2, 1.5, 1, ¾, ½ MiB of base64) so the share only changes at a few counts as a thread grows. Image budgets per request: Anthropic 24 MiB (32 MB limit), OpenAI 40 MiB, Gemini and unknown/LiteLLM vendors 15 MiB, Groq 3 MiB (4 MB). Edges: 8000 px; 2000 px once a request has more than 20 images (Anthropic's rule, applied to every provider since Claude is also reachable through routers); 5760 px for Groq (33 MP). A request carries at most `max_images_for_request` images: the vendor's count limit (Anthropic 100, Groq 5) and no more than fit its budget at the smallest tier (Anthropic 48, OpenAI 80, Gemini/others 30). Beyond that the **oldest history attachments** are replaced by a text note, in blocks of a quarter of the cap, so the replayed history (and the vendor's prompt cache over it) only changes every few image turns. Current-turn and tool-result images are always sent.
- **Passthrough** (bytes untouched): the vendor documents the format (`passthrough_formats_for`: Anthropic/OpenAI JPEG/PNG/GIF/WebP, Gemini JPEG/PNG/WebP, everyone else incl. xAI JPEG/PNG), the base64 fits the per-image budget, edges fit, no EXIF rotation, not animated. Decided from the header, plus a cheap integrity check (PNG chunk CRCs through IEND, JPEG decoded at 1/8 scale, GIF trailer). A file that fails the check isn't refused; it takes the conversion path, whose full decode is lenient (a bad ancillary-chunk CRC or a missing IEND still converts) and reports real truncation readably, instead of a broken file breaking every later turn at the vendor.
- **Otherwise: lossless PNG** (accepted by every vendor). The first frame is decoded, EXIF orientation applied, and the mode normalized to 8-bit L/RGB/RGBA. 16-bit/32-bit greyscale maps by the smallest standard depth (8/10/12/14/16 bits) holding its maximum, so 12-bit camera/medical data in a 16-bit container isn't black; float greyscale as 0..1. The ICC profile is kept when it matches the colour space; EXIF (incl. GPS) is dropped. If it is over budget, it is downscaled (LANCZOS) and re-encoded losslessly; a 6×6 tile-mosaic size estimate picks the size, so a typical photo needs one full encode. Downscaling stops at the size Claude's standard tier works at (1568 px long edge / ~1.2 MP). Only if lossless can't fit there does it fall back to **JPEG at a 1568 px long edge, q90→50**, then smaller (alpha flattened onto white). In practice that happens with roughly 20+ images in one request.
- **Camera RAW** (DNG incl. phone ProRAW/Expert RAW, CR2/CR3, NEF, ARW, RAF, ORF, RW2, PEF, X3F, … — whatever LibRaw reads) is recognized by its structure (`camera_raw_kind`). That means a RAW format's signature (CR3, RAF, ORF, RW2, X3F, MRW, CRW, Phase One/Leaf IIQ — also TIFF-wrapped), or a TIFF whose first IFD only a RAW has: a DNG version tag, a CR2 header, colour-filter-array or linear-raw photometric, a camera maker's compression, or SubIFDs under a preview IFD or an IFD with no image of its own (Samsung SRW). Bytes nothing recognizes also go to LibRaw when they are declared with a RAW media type. Nothing else does: LibRaw also "reads" headerless sensor dumps identified by file size alone, i.e. any file of such a size, and demosaics plain 16-bit TIFFs as if they were Bayer data.
  - `graph/raw_decode.py` renders it **in a child process**, which reads the file from a temporary file on disk. LibRaw is a large C++ parser with a history of memory-safety bugs, so a crash, runaway allocation, hang or exploited parser bug costs the child, not the shared server:
    - when the server runs as root (as in its container), the child runs as `nobody` (`IMAGE_RAW_UID`), so it can't read the server's environment through `/proc` or signal the server. Its own temporary file is handed to `nobody` only while it runs; every other request's file stays the server's, and the disk cache directory is `0700`;
    - it runs in its own session, with `python -I` and `OMP_NUM_THREADS=1`, under a wall-clock timeout that kills the whole session. The server reads at most one image's worth of its output;
    - it caps its own address space (decode budget + 256 MiB), CPU time and core dumps, sets no-new-privs and `oom_score_adj=1000`;
    - before LibRaw parses a byte, it locks itself down with limits it can't lift: no new processes or threads, and a seccomp filter that refuses sockets (no network, not even the server's own port), exec, ptrace and every file system change (opening for write, creating, renaming, linking, deleting, chmod/chown). It fails closed if the filter can't be installed. Reading world-readable files is all that is left.
  - It renders, in order:
    - the **camera's embedded preview**, when its long edge is at least 1568 px. That is the camera's own rendering (white balance, tone curve, picture style), and it is what galleries show for RAW files. It is decoded at 1/2–1/8 scale when large and oriented once (the preview's own EXIF orientation, else LibRaw's flip — unless camera software already turned its pixels upright, as Nikon Transfer does; a DNG's previews are always turned, since they may be cropped). A bitmap preview whose orientation can't be told (LibRaw turns some itself) loses to the demosaic. A preview that can't be decoded counts as none;
    - otherwise a **LibRaw demosaic** of the sensor data (camera white balance, sRGB, 8-bit, half size when that still covers 1568 px), if its estimated memory fits the decode budget. Bayer data is costed at 6 B per sensor pixel at half size and 14 at full size. Non-Bayer data (linear DNG such as ProRAW/Expert RAW, Canon sRAW, Foveon) is costed at 28, since half size doesn't shrink it. rawpy can't tell the two apart before unpacking the sensor data, so the unpack itself is held to the decode budget;
    - otherwise any preview at least 128 px long: when the demosaic is over budget, or LibRaw can't decode the sensor data (e.g. a truncated file). The preview is read before the demosaic is tried, because a failed demosaic leaves LibRaw's handle unusable.
  - The upright RGB result (≤ 3200 px) then goes through the normal lossless-PNG path. `IMAGE_RAW_RENDER=demosaic` always renders the sensor data instead of the preview.
  - Camera RAW objects larger than `IMAGE_MAX_SOURCE_BYTES` are common: 50 MP phone DNGs are ~100–150 MB, and uncompressed or medium-format RAWs ~120–300 MB. Above `IMAGE_MAX_SOURCE_BYTES`, the first 256 KiB of an object is read to recognize a camera RAW by its structure (plus a ranged read of the first TIFF IFD when it lies further in, as in dnglab's DNGs; a RAW media type alone isn't enough). A RAW up to `IMAGE_MAX_RAW_SOURCE_BYTES` is then streamed from S3 straight to the temporary file, never into memory; anything else is refused.
  - LibRaw's verdict on a file (unreadable, or too large to render) is remembered per S3 key for 6 hours, whatever the request's limits, so a large RAW isn't downloaded again each time a conversation's per-image limits change. Remembered failures are kept apart from the result LRU, so other conversations' images don't push them out.
  - Measured on one core (child CPU time / child peak RSS): a 21 MP CR2 0.2 s / 84 MB (preview), a 12 MP NEF 0.5 s / 141 MB (preview), an X3F 0.7 s / 131 MB (demosaic), a 60 MP Bayer DNG without a preview 1.7 s / 365 MB, and a 293 MB 48 MP linear DNG 0.2 s / 43 MB (its preview: unpacking it would exceed the budget).
- **Unusable files fail the turn with a readable message.** These are `ImageNormalizationError` (a `ValueError`) and its subclasses `UnsupportedImageError` (SVG, PDF, unreadable camera RAW, video, unsupported formats, corrupt/truncated), `ImageTooLargeError`, and `ImageTemporarilyUnavailableError` (S3 unreachable, local disk full; never remembered). Streaming: `streaming.user_facing_llm_error` passes the message through verbatim as `error_type: "attachment_error"`. Non-streaming `/retrieve` returns 422 `{"detail": {"error_type": "attachment_error", "message": ...}}`, which the proxy returns as the response text. In history replay (`strict=False`) a failed image degrades to `[attached image unavailable]`.
- **Resource guards** (one process, 1 GB RAM, one shared CPU serves everyone):
  - Before decoding, the memory a decode → resize → encode will need is estimated from the header: decoded pixels × a measured per-format cost (PNG/TIFF/PSD 6 B/px, JPEG 7.5 of its drafted size, WebP 17, JPEG 2000 20; ×2 with alpha or >8-bit samples). HEIF and AVIF costs come from the file's bit depth and chroma subsampling (HEIF: 7.2 for 8-bit 4:2:0 up to 15.2 for 10-bit 4:4:4; unknown layouts get the worst case). Anything over `IMAGE_MAX_DECODE_BYTES` is refused. This admits a 48 MP iPhone HEIC (8-bit 4:2:0) and refuses a 48 MP 10-bit 4:2:2 camera HEIF. The limit for WebP is ~22 MP, and for 8-bit 4:2:0 AVIF ~41 MP.
  - Baseline JPEGs up to 256 MP decode at 1/2–1/8 scale via `draft()`, and JPEG 2000 via OpenJPEG's reduce (stepping down for codestreams with fewer resolution levels). Progressive JPEGs, and sequential ones whose scans aren't interleaved (detected by walking the markers up to the first scan), keep a full coefficient buffer: 3 B/px at 4:2:0 up to 6 at 4:4:4, read from the header. That buffer is sized against the same budget, and `JPEGMEM` (matched to the budget) is the backstop.
  - The source size is checked from S3 `ContentLength` before the body is read. Over the limit, only a peek at the start is read (camera RAWs, see above).
  - Fetch + normalize run on one dedicated worker thread (not asyncio's default executor), so one source is resident and decoding at a time.
  - Results are cached by `(s3_key, ImageLimits)`: a byte-bounded in-memory LRU (`IMAGE_CACHE_BYTES`) over a local-disk tier (`IMAGE_DISK_CACHE_BYTES` in `IMAGE_DISK_CACHE_DIR`). Without the disk tier, several image-heavy conversations taking turns defeat the LRU, because each replay walks its images in order. Failures are remembered for 10 minutes, then retried, since they may have been transient.

| Env var | Default | Meaning |
|---|---|---|
| `IMAGE_MAX_BASE64_BYTES` | 5 MiB | Per-image cap on the **base64** string (Anthropic's 5 MB limit on Bedrock/Vertex is measured on base64). Per-request shares are tiers at or below it. |
| `IMAGE_MAX_EDGE_PX` | 8000 | Anthropic's max dimension. |
| `IMAGE_MAX_DECODE_BYTES` | 370,000,000 | Decompression-bomb / OOM guard: estimated peak bytes for one conversion. |
| `IMAGE_MAX_SOURCE_BYTES` | 100 MiB | Operational OOM guard, not a product limit. Covers 200 MP JPEGs (~25–60 MB) and 48 MP PNGs (~75 MB). |
| `IMAGE_MAX_RAW_SOURCE_BYTES` | 400 MiB | Camera RAW objects over `IMAGE_MAX_SOURCE_BYTES` are streamed to disk for the RAW child, up to this size. |
| `IMAGE_CACHE_BYTES` | 64 MiB | In-memory normalized-image cache (base64 bytes). |
| `IMAGE_DISK_CACHE_BYTES` | 512 MiB | Local-disk normalized-image cache (0 disables). |
| `IMAGE_DISK_CACHE_DIR` | `$TMPDIR/attachment-images` | Where the disk cache lives. |
| `IMAGE_RAW_RENDER` | `preview` | Camera RAW: `preview` (the camera's embedded rendering when ≥ 1568 px, else demosaic) or `demosaic` (always render the sensor data). |
| `IMAGE_RAW_TIMEOUT_S` / `IMAGE_RAW_CPU_SECONDS` | 90 / 60 | Camera RAW child: wall-clock timeout / CPU-time cap. |
| `IMAGE_RAW_UID` | 65534 | The uid/gid the camera RAW child runs as when the server runs as root (`nobody`). `0` keeps root, e.g. in a dev container whose interpreter `nobody` can't reach. Never use `0` in production. |

Measured on one core (`taskset -c 0`, synthetic photo-like fixtures; output for a single image to Claude unless noted):

| Input | Wall time | Peak RSS growth | Output |
|---|---|---|---|
| 12 MP HEIC | 1.4 s | +93 MB | 2005×1504 lossless PNG |
| 12 MP HEIC, 10 images in the request | 1.0 s | +92 MB | 1275×956 lossless PNG (1.8 MiB) |
| 12 MP HEIC, 20+ images | 1.2 s | +93 MB | 1568×1176 JPEG (0.25 MiB) |
| 48 MP HEIC | 2.8 s | +335 MB | 2123×1592 lossless PNG |
| 48 MP JPEG / 200 MP JPEG | 1.0 / 1.2 s | +85 MB | ~2000 px lossless PNG |
| 48 MP CMYK JPEG | 1.3 s | +93 MB | |
| 48 MP progressive JPEG (4:2:0 / 4:4:4) | 1.3 / 1.6 s | +188 / +327 MB | |
| 48 MP 10-bit HEIC (4:2:0) | 4.3 s | +362 MB | |
| 48 MP JPEG 2000 | 2.4 s | +241 MB | |
| 48 MP PNG (77 MB) | 2.3 s | +249 MB | |
| 24 MP RGBA PNG | 2.1 s | +229 MB | |
| 48 MP WebP / AVIF, 10-bit 4:2:2 or 4:4:4 HEIF | — | +4–6 MB | refused: over the decode budget |

In-budget JPEG/PNG pass through in under 30 ms (integrity check included).

The HEIC test fixtures are committed; `tests/fixtures/make_heic_fixtures.py` regenerates them (it needs the full pillow-heif encoder, not a runtime dependency).

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
| `write_todos` | `graph_tools/tools/write_todos.py` | the agent's plan as a checklist; full-list replace; current list lands in `scratch["todos"]`, rides the tools step of the activity log (`todos` field) and is persisted by the proxy with the turn's `activityJson` |
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
  environment-scoped **`SUPABASE_URL` GitHub Actions secret** if that secret exists — so add it per
  environment (dev/prod point at different Supabase projects) to keep deploys reproducible.

**Idle polling and cleanup.** DBOS polls Postgres on fixed timers even when no run exists, and
Supabase bills what those polls return as egress: at DBOS's 1-second defaults, one always-on
process uses up the free plan's egress. So runs start directly rather than through a DBOS queue
(startup deletes any queue registered under this app), and `durable_runtime._quiet_idle_polling`
slows DBOS's remaining loops to about one statement per second per process. It sets DBOS
internals, which is why `dbos` is pinned exactly; re-check those internals before bumping it.

Ended runs don't linger. Each workflow deletes its LangGraph checkpoints when it ends, and a sweep
(`run_cleanup.sweep`, at startup and then every `RUN_CLEANUP_INTERVAL_SEC`, default 10 minutes)
deletes runs that ended more than `RUN_RETENTION_SEC` (default 30 minutes) ago, plus any checkpoint
or event rows left without a run. Customer content therefore stays in Supabase only while a run is
in flight and for under an hour after, which is what the privacy policy promises; keep the two
settings' sum under an hour.

**Connection budget.** The session pooler refuses new clients once the project's pool is full (15
on the smallest compute), counting every machine and laptop pointed at that project. Each process
opens at most `DBOS_POOL_SIZE` (default 4) connections for DBOS plus `CHECKPOINTER_POOL_MAX`
(default 3) for checkpoints and run events, so two machines use at most 14. DBOS keeps every
connection it opens until the process exits; when all are busy, a statement waits in the process
for one to free up instead of being refused by Supabase. Raise the caps only together with the
project's pool size.
