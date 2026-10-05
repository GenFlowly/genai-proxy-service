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

**Swallowed failures must still count.** When an operation degrades instead of raising (graph nodes returning empty results), put `@track` on a raising inner function and catch around the call — a metric that can never record `status=error` is useless for alarming. See `graph/nodes/retrieval.py` / `graph/nodes/web_search.py` for the pattern. Existing degradation counters: `memory_load_failure_total`, `graph_stale_serve_total`, `stream_zero_tokens_total`, `stream_error_total`, `zilliz_credential_fallback_total`.

**Logging**: emit structured context via `extra={...}` (rendered as JSON fields), not f-string interpolation, for anything a dashboard or Logs Insights query might filter on. Never rely on log-message wording for alarms — that's what the counters are for.

**Request id**: the middleware in `app.py` adopts the proxy's `X-Request-Id` (or mints one) and binds it to the logging contextvar, so every log line of a request carries `request_id` automatically — nothing to do per-module.

## Third-party calls: retry with exponential backoff

Every outbound call to a third-party API MUST go through `encoding_library.utils.retry` (`@retry`, `retry_call`, or a `RetryingProxy`-wrapped client). Each retry emits `retry_attempt_total{operation}`; giving up emits `retry_exhausted_total{operation}`.

- **Milvus/Zilliz**: `get_milvus_client()` already returns a retry-wrapped client — use it, never construct `MilvusClient` directly.
- **Embeddings**: `create_embeddings()` retries internally.
- **HTTP calls**: pass `retry_if=is_transient_http_error` so only connection errors, 429 and 5xx retry — a 401/404 must fail fast. Call `raise_for_status()` *inside* the retried function, or 429/5xx responses won't trigger a retry.
- **LLM chat calls are the exception**: they retry inside the vendor SDKs (`max_retries` in `graph/llm_factory.py`), not through this util — re-issuing a generation from our layer can double-bill when the original request actually succeeded server-side. Same for key validation (SDK-level; auth errors must not retry).
- **boto3 (DynamoDB/S3/KMS)** has its own built-in backoff — don't double-wrap.
- **Voice realtime websockets** are stateful sessions; reconnection is session logic, deliberately not covered by this util.

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
streaming, and the durable /runs path treat both shapes identically.

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

Planned next (in order): a `run_graph` tool exposing a pipeline graph as one
callable step for agents; a `spawn_agent` tool (child agent loops with depth +
token budgets) — which is what makes orchestrator/parallel-worker/judge
patterns emergent model behavior rather than topology; an AGENT node type so
pipelines can embed a bounded agent loop as one node.

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
