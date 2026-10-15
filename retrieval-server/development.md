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

## Durable runs: deploy rules

Durable runs are ON in production: every streaming agentic chat turn is an `agent_run` DBOS
workflow, and request agents (titles, personas, memory extraction) run as `request_agent_run`
whenever `DATABASE_URL` is set. A process death interrupts every tenant's in-flight runs, and the
next start recovers them. These rules keep that recovery safe.

**One machine, executor `local`.** Production runs exactly one machine of the smallest Fly size
(`shared-cpu-1x`, 1024 MB, `fly.production.toml`), and that stays so. Every machine's DBOS executor
id is `local` (nothing sets `DBOS__VMID`), and a starting machine re-enqueues *every* PENDING run of
executor `local`. So:

- **Never add a second machine** (`fly scale count`, a second region, a standby) while executors
  share `local`. A restarting machine would re-enqueue the other machine's live runs: two
  executions would write the same run (`run_events` assumes one writer per run), re-run its tool
  calls, and `request_agent_run` — capped at `max_recovery_attempts=0` (runs.py) because its HTTP
  caller is gone after a crash — would dead-letter a peer's live request.
- **Keep Fly's default rolling deploy**, which replaces the one machine in place. The deploy
  workflows pass no `--strategy`; never use `bluegreen` or `canary` (both run two machines at once).

**Recovery caps** (runs.py). `agent_run` has `max_recovery_attempts=3`: a run that kills the process
is executed at most 4 times and dead-lettered (status `MAX_RECOVERY_ATTEMPTS_EXCEEDED`) on the 4th
restart without executing again. Deploys and innocent runs caught in a crash also use attempts, so
do not lower it. `request_agent_run` has 0: a crash dead-letters it on the next start.

**Pinned versions.** `dbos`, `langgraph`, `langgraph-checkpoint` and
`langgraph-checkpoint-postgres` are pinned exactly in requirements.txt. Upgrading one is a
deliberate change: re-run the durable integration tests (`tests/test_durable_*.py`) and bump
`DBOS_APP_VERSION`.

### `DBOS_APP_VERSION`

DBOS recovers and dequeues only workflows whose application version equals the running one. When
`DBOS_APP_VERSION` is unset, DBOS computes the version as a hash of the workflow wrappers' source
(`agent_run`, `request_agent_run`, decorator lines included), the step registrations and the
installed dbos version. That hash is wrong in both directions: it changes on edits that are safe for
in-flight runs (a decorator argument, a dbos rebuild) and stays the same on edits that are not. The
order of DBOS steps a run takes is decided by graph code (`llm_node.py`, `reflection_node.py`,
`tool_executor.py`, `subagent.py`, `runs.py`), and a replay on a different step order reads the
wrong memo; all LLM steps share the name `llm_invoke`, so DBOS cannot notice. So production sets
`DBOS_APP_VERSION` (read in durable_runtime.py) and bumps it by hand.

**Rule: bump `DBOS_APP_VERSION` in the same change whenever the sequence of DBOS steps a run can
take may change** — adding, removing or reordering a step call (`load_graph`, `llm_invoke`,
`tool_invoke`, `recv`), changing which nodes or tools run in which order, or upgrading a pinned
package above. Do not bump it for anything else: a bump strands every in-flight run (they are never
recovered). Add the bump to the release checklist of any such change.

**Setting it for the first time** (the deploy that ships the recovery caps — that edit changes
the computed hash but not the step order, so pin the version production computes today and no
in-flight run is stranded):

1. Read production's current version, by any of:
   - Supabase SQL editor (prod project):
     `SELECT application_version, created_at FROM dbos.workflow_status ORDER BY created_at DESC LIMIT 1;`
   - from a Python shell with production's `DATABASE_URL` and DBOS launched:
     `(await DBOS.get_latest_application_version_async())["version_name"]`;
   - the DBOS boot log line `Application version: <hash>` (`fly logs -a genai-retrieval-server-production`).
2. Set it before the deploy, staged so the deploy picks it up:
   `flyctl secrets set --app genai-retrieval-server-production --stage DBOS_APP_VERSION=<hash>`
   (the same for `genai-retrieval-server-development`, with the dev database's value).
3. After the deploy, `GET /runs?limit=5` (or the query above) shows new runs with that
   `app_version`, and rebuilding the image with no workflow change keeps it.

**Bumping it** (a change to the step sequence): set a new descriptive value in the same deploy,
for example `flyctl secrets set --app genai-retrieval-server-production --stage
DBOS_APP_VERSION=rs-2026-10-15-tool-steps`. Runs in flight at that deploy are stranded; nothing
re-executes them on the new step order, and the run sweep ends them with an error (below).

### How a recovered run replays

DBOS does not resume a run where it stopped: it re-executes the workflow from the top, and
LangGraph restarts the graph from START. `runs.py` makes that re-execution a deterministic replay:

- **Clean replay.** Before streaming (once per execution, never inside the human-input loop), a
  thread that already has checkpoint values marks a re-execution: the run deletes the thread's
  checkpoints, counts `durable_run_recovered_total` and publishes `{"content_reset": true}`, then
  runs the graph from START on the initial state.
- **Every completed step replays from the DBOS memo, in call order**: `load_graph` (the graph and
  node configs as recorded — a customer's edits since do not apply), `llm_invoke` (no vendor call,
  identical tool-call ids), `tool_invoke` (the tool does not run again) and `DBOS.recv` (the
  human input it received). The LLM call in flight at the crash is sent again.
- **The tool call in flight at the crash is not run again.** `tool_invoke` records each attempt
  in `tool_call_attempts` (tool_ledger.py) before running the tool; a re-execution that finds an
  earlier attempt of the same step returns the error result *"This tool call was interrupted when
  the server restarted and was not run again."* to the model and counts
  `tool_call_interrupted_total{tool}`. A tool that kills the process therefore does so once. The
  ledger holds ids, tool names and statuses — never arguments or results — and is pruned with
  `run_events` after `RUN_EVENTS_TTL_SEC`.
- **A different call at a recorded step** (`ReplayDivergence`), or a step recorded under another
  name (`DBOSUnexpectedStepError`), fails the run: the tool executor re-raises them instead of
  turning them into tool errors. That is what a missed `DBOS_APP_VERSION` bump looks like.
- `spawn_agent` is not a step (a step inside a step runs as a plain function and would lose the
  child's memos); the child's own LLM and tool calls are steps of the parent's workflow.
- Artifacts get deterministic ids on the durable path (`uuid5` of customer, run, step and call),
  and the scratch-FS namespace derives from the run id, so a replayed call addresses the same keys.
- Usage is published from the checkpointed state (replayed LLM calls fire no model events), and an
  answer that replayed from the memo is published from the final state.

The deploy that ships this replay (the `tool_invoke` and `load_graph` steps) changes the step
sequence, so it **must bump `DBOS_APP_VERSION`**: a pre-change run replayed on the new code would
find `llm_invoke` recorded where `load_graph` now runs. `tests/test_durable_replay.py` pins the
recorded step sequence of a two-round run and fails when it changes.

### Failed, dead-lettered and stranded runs end with an error

A run that ends without finishing must still end its event stream with an error the user sees
(contract C5: a standalone `{"error", "error_type"}` row, then the terminal
`{"status": "error", ...}` row; `run_events.failure_events`). Three places do that:

- **The run itself** (runs.py) publishes its own failures — `resume_timeout`, `runaway` — as a
  standalone error row before its terminal summary.
- **The tail** (`GET /runs/{id}/stream`) writes the same two frames, then `[DONE]`, when the run's
  DBOS status is `ERROR` (`error_type: "error"`) or `MAX_RECOVERY_ATTEMPTS_EXCEEDED` (`run_lost`)
  and no terminal row exists, so a live viewer does not wait for the sweep. It writes none for
  `CANCELLED` (the user asked for it) and none at its 30-minute idle cap (the run is still
  PENDING, e.g. waiting for human input; the proxy re-attaches).
- **The run sweep** (`durable_runtime._sweep_loop`, first pass ~10 s after startup, then every
  60 s) persists the rows through `run_events.publish_terminal_once`, which writes them only if
  the run has no terminal row yet, so passes and restarts never duplicate them. Each pass:
  - ends `agent_run`s that are `MAX_RECOVERY_ATTEMPTS_EXCEEDED` (`run_lost`) or `ERROR`
    (`error`), created within `RUN_EVENTS_TTL_SEC`;
  - cancels `agent_run`s still PENDING/ENQUEUED under another app version after 10 minutes
    (`DURABLE_STRANDED_AFTER_SEC`) and ends them (`run_lost`);
  - logs and counts `request_agent_run` dead letters once each (their caller is gone, there is
    no stream to end).

DBOS statuses are left as they are, for ops. Logs carry only the workflow id, name, status,
`recovery_attempts`, executor and app version — a workflow's input is the user's request and is
never logged. Dead letters count `durable_run_dead_lettered_total{workflow}`.

### Seeing restarts, recoveries and dead letters

- **Startup log.** Right after `DBOS.launch()` the server logs one WARNING with the number and ids
  of the runs it recovers (and one naming PENDING/ENQUEUED runs of another app version, which it
  will not recover). Ids only.
- **Metrics** (`durable_metrics.py`, prometheus_client default registry, served at `/metrics`):
  `durable_run_recovered_total`, `durable_run_dead_lettered_total{workflow}`,
  `tool_call_interrupted_total{tool}`, next to the existing `agent_run_total{status,source}`,
  `agent_run_started_total` and `request_agent_run_total`.
- **Dashboard.** Backend Services has an "Agent runs" row (and a "PDF generation" row), generated by
  `observability/grafana/generate_api_dashboards.py`.
- **Alerts.** `observability/grafana/alerts/retrieval-alerts-{env}.json`: process restarts, memory
  above 90%, any `agent_run` dead letter, more than 3 recoveries in an hour, and the `agent_run`
  error rate (see that directory's README for deployment).
- **`/ready`** returns 503 when durable runs are configured (`DATABASE_URL` set) but did not start,
  200 otherwise; `[checks.ready]` in both Fly configs polls it, and the production deploy gate
  requires every machine check to pass. Readiness is decided once at startup and never cleared, so
  it reports a failed startup, not a later database outage. `/health` stays constant, so a database
  outage never turns into a restart loop.

### Purging run data (customer deletion)

Postgres holds user content for every durable run: the DBOS workflow input (the whole request),
step outputs (memoized LLM responses and tool results), LangGraph checkpoints, `run_events` rows
and `tool_call_attempts` rows.

- **`DELETE /runs/{run_id}/data`** purges all of it for one run: `DBOS.delete_workflows_async([run_id],
  delete_children=True)` (status, input, output, step outputs; messages and events cascade),
  `checkpointer.adelete_thread(run_id)` (every namespace), `DELETE FROM run_events WHERE run_id`
  and `tool_ledger.delete_workflow`. It is idempotent (204 again on a repeat, also for an unknown
  run) and answers 409 while the run may still execute (PENDING/ENQUEUED): cancel it, wait until
  `GET /runs/{id}` is terminal, retry. `tool_ledger.delete_customer(customer_id)` purges a
  customer's ledger rows in one statement.
- **Authorization.** Like every retrieval-server route, this one has no app-level authentication;
  only the app's private Flycast address keeps it off the internet. **The proxy is the
  authorization point**: it calls it only from the customer-deletion purge job, with run ids read
  from its own rows, never with an id a client sent.
- **Request agents** (`request_agent_run`: titles, personas, memory extraction) keep nothing:
  `execute_agent_graph` runs the workflow under workflow id = run id (`ra-…`, also the checkpoint
  thread) and deletes its DBOS rows and checkpoints in a `finally` once it has the result. Rows a
  crash leaves behind (the run is dead-lettered on the next start) are deleted by the run sweep
  once older than an hour (`DURABLE_REQUEST_RUN_RETENTION_SEC`).

**Manual replay** of a dead-lettered `agent_run` (ops only): from a Python shell with the
production `DATABASE_URL` and DBOS launched,
`await DBOS.resume_workflow_async("<run id>", queue_name="agent_runs")`. It resets the attempt
count to 0 and works only while the run's app version is the current one. Pass `queue_name`, or the
run lands on DBOS's internal queue and skips the `agent_runs` concurrency cap. If the sweep has
already ended the run, its stream is over: the user saw the error, and the replayed output is not
shown.

## PDFs: generating, revising and reading them

### Local setup

Install with the same constraints as CI and the image, then fetch the
Typst renderer's fonts (pinned by hash; the binaries are not committed):

```bash
pip install -c constraints.txt -r requirements.txt -r requirements-dev.txt
python scripts/fetch_fonts.py --cache-dir ~/.cache/genflowly-fonts
```

`constraints.txt` pins the packages that exist only for the x2p_v1 stack
(xhtml2pdf, reportlab, Markdown and their closure); shared packages stay
unpinned. Without the fonts, Typst is reported as unavailable (the renderer
flag falls back to x2p_v1 with a warning) and the Typst render tests skip.

### Where rendering and parsing run

Nothing PDF-related runs in the server process. `graph/pdf_worker.py` runs
`generate_pdf.render_job` (and PDFium parsing of uploaded PDFs) in a child
process (`graph/pdf_render_child.py`) with an address-space cap, a per-job
CPU cap, no core dumps, a seccomp filter (no sockets, exec or ptrace), a
scrubbed environment, stderr on /dev/null and, when the server is root, the
`nobody` user. x2p_v1 keeps one warm child (recycled after 25 renders,
300 MB RSS, any failure or 10 idle minutes); Typst renders and PDF parsing
get a one-shot child, and the idle warm child is stopped first. Every child
takes the process-wide heavy slot shared with image normalization
(`graph/heavy_slot.py`); a job that waits 30 s gets "busy" instead.

| Env var | Default | Meaning |
|---|---|---|
| `PDF_QUEUE_WAIT_SECONDS` | 30 | wait for the heavy slot before "busy" |
| `PDF_RENDER_TIMEOUT_SECONDS` | 120 | wall clock per render, then the child is killed |
| `PDF_RENDER_RLIMIT_MB` / `PDF_TYPST_RLIMIT_MB` / `PDF_PARSE_RLIMIT_MB` | 400 / 512 / 512 | address-space caps |
| `PDF_RENDER_CPU_SECONDS` | 115 | CPU seconds per job |
| `PDF_WORKER_RECYCLE_RENDERS` / `PDF_WORKER_RECYCLE_RSS_MB` / `PDF_WORKER_IDLE_SECONDS` | 25 / 300 / 600 | warm-child recycling |
| `PDF_PARSE_TIMEOUT_SECONDS` | 60 | wall clock per uploaded-PDF parse |

The image build runs `python -E -s -m graph.pdf_render_child --selftest`:
it renders with every renderer the image ships and parses the result with
PDFium, so a broken child, font set or library fails the build.

### Choosing the renderer (plan 2.1 / 5.2)

The renderer is resolved once per turn (the `/retrieve` handler, `POST
/runs` before enqueue) and pinned on the request, so a durable run recovered
after a change keeps the renderer it started with.

| Env var | Values | Meaning |
|---|---|---|
| `PDF_RENDERER` | `x2p_v1` (default), `typst` | default renderer |
| `PDF_RENDERER_CANARY` + `PDF_RENDERER_CANARY_CUSTOMERS` | renderer, comma-separated customer ids | canary for listed customers |
| `PDF_RENDERER_SCRIPT_ROUTE` | `typst` or unset | documents with letters x2p_v1 cannot draw go to Typst (when the bundled fonts cover them) |
| `PDF_TYPST_MAX_CHARS` / `PDF_TYPST_MAX_TABLE_ROWS` | 150000 / 1000 | Typst input caps; raise after calibration (e.g. 300000 / 2500) |

They are plain settings, not secrets: set them in the app's `[env]` in
`fly.toml` (development, which already sets `PDF_RENDERER = "typst"`) or
`fly.production.toml`, so the change is reviewed and ships with the next
deploy. Changing any of these changes Fly env, which restarts the single
machine and triggers DBOS recovery: flip at a quiet hour and check the
recovery panel afterwards. The canary stages are: dev default, internal tenants
(canary list, at least 7 days), script route for everyone (at least 14
days), production default, then removal of xhtml2pdf. Compare the
`pdf_render_*` metrics by renderer at each stage. When xhtml2pdf is finally
removed from the image, runs pinned to `x2p_v1` render with Typst.

### Files on later turns

Every generated PDF's Markdown is stored next to it at `<key>.source.md`
(same tags), so `revise_pdf` applies exact edits on a later turn and
`read_pdf_source` reads it; ids resolve only through the conversation's file
references (`FileRef`s the proxy sends), never through a key built from model
input. Uploaded PDFs are parsed once and cached at
`<s3_key>.derived/text-v1.json` (`retention=derived`); the model gets the
native file on the turn it was attached (when the model reads PDFs), the
extracted text otherwise or on later turns, and `read_attachment` for the
rest.

### Locale, page size and letterhead (plan 6.1 / 6.2)

Typst only (x2p_v1 ignores all of this). The proxy sends the browser's
`Accept-Language` as `raw_data.locale`: `en-US` and `en-CA` default to Letter,
everything else to A4, and the footer's page label is translated. A
`TOOL_EXECUTOR` node can carry per-agent settings:

```json
{"tools": ["generate_pdf"],
 "tool_settings": {"generate_pdf": {
   "default_page_size": "Letter",
   "company_name": "Acme GmbH",
   "footer_text": "Confidential",
   "accent_color": "#1F4E79",
   "logo_attachment_id": "<attachment id>"}}}
```

The admin panel edits these for System agents (agent editor, "PDF
letterhead"). The model's explicit `page_size` beats `default_page_size`.
The logo is read from the graph owner's prefix,
`customers/<graph owner>/attachments/<id>` (the owner is the graph record's
`customerId`, `System` for published agents, which the loaders stamp on the
node config as `_graph_owner`, replacing any stored value), then from
`customers/System/attachments/<id>`, which holds only the logos admins upload
(so a customer's fork of a System agent keeps its letterhead). No other
customer's prefix is ever read: such an id is not found, the PDF renders
without a logo and `pdf_render_warnings_total{kind="branding_logo_unavailable"}`
counts it. The renderer accepts PNG or JPEG up to 2 MB.

### Object tags

Everything a tool stores carries a `retention` tag at write time:
`pending` for artifacts and their source sidecars (the proxy claims them
when it persists the message), `scratch` for fs_write files and spilled tool
output, `derived` for extracted text. The bucket's lifecycle rules expire
them (see genai-proxy-server/development.md for the rules and their rollout
order).

### Before shipping new built-in tools

`revise_pdf`, `read_pdf_source` and `read_attachment` resolve before customer
tools of the same name. Run the read-only scan against each stage first:

```bash
python scripts/scan_reserved_tool_names.py --region us-east-1
```

Any conflict must be renamed with its customer before the deploy.
