# Durable Agentic Runtime — DBOS Integration Plan (retrieval-server)

Status: **P0 spike complete and green** (verified against the real Supabase session
pooler). Building P1c on top of it. Verified: dbos 3.0.0, langgraph-checkpoint-postgres
3.1.2, psycopg 3.3.6.

## ✅ P0 spike results (supersede the assumptions below where they differ)

Run against the project's Supabase **session pooler** (IPv4, port 5432, Postgres 17.6):

- **Checkpointer works over the pooler** — `AsyncPostgresSaver.setup()` + checkpoint
  put/get/list all pass.
- **DBOS works over the pooler** — launch + migrations, sync & async workflows, queue
  enqueue, `send`/`recv` (HITL), `set_event`/`get_event` all pass.
- **Crash-resume works** — a workflow SIGKILL'd mid-run (after step 1, before step 2)
  resumed on relaunch and completed; step 1 was not lost. This is the whole plan's core
  claim, proven end-to-end.
- **LISTEN/NOTIFY does NOT work over the Supavisor pooler** — even in session mode (it
  multiplexes backends). Two consequences, both resolved:
  - **DBOS**: run with **`use_listen_notify=False`** (a first-class DBOSConfig option) →
    DBOS polls instead. Confirmed working.
  - **Reattach channel (§5.6)**: **poll the events table** instead of `LISTEN/NOTIFY`
    (see the corrected §5.6). No Redis, no IPv4 add-on, no direct (IPv6) connection needed.
- **Single Supabase DB is fine** — DBOS puts its tables in a schema via
  **`dbos_system_schema`** (no separate database / `CREATE DATABASE` needed).
- **Locked DBOSConfig**: `system_database_url` = the session-pooler URL, `use_listen_notify:
  False`, `dbos_system_schema: "dbos"`, `run_migrations: True`.

The connection-mode table in §4 is now moot in one respect: since the reattach channel
polls (no NOTIFY dependency) and DBOS runs with `use_listen_notify=False`, the **session
pooler is fully sufficient** — the direct (IPv6) connection is not required.

---

Status: proposal / design. No code changed yet.

Goal: evolve the retrieval-server from a **stateless per-call graph runner** into a
**durable agentic runtime** — runs that survive client disconnect, process crash, and
redeploy; in-graph human-in-the-loop; exactly-once LLM steps; reattachable streams —
using **DBOS** (durable execution as a Postgres-backed *library*, MIT/OSS) plus a
**LangGraph Postgres checkpointer**. No LangGraph Platform license, no phone-home,
least new infra (one **Supabase** Postgres, managed — no DB or new always-on compute to
run on Fly).

---

## 1. Current state (grounded in the code)

| Fact | Where | Implication |
|---|---|---|
| Retrieval-server is **stateless per call** | `routes/retrieve.py:194` `retrieve(req)` builds state fresh; `run_config = {"recursion_limit": …}` (no thread/checkpointer) | Nothing survives a disconnect or crash mid-run. |
| The **proxy is the state-keeper** | `RetrieveRequest` (`models.py:93`) carries full `conversation_history` + `tool_results`; there is **no** conversationId/runId here | "Resume" today = proxy replays full history. Retrieval-server doesn't know a conversation exists. |
| Graph compiled **without a checkpointer** | `graph/dynamic_graph.py:125` `compiled = workflow.compile()` | Add a checkpointer here to unlock `interrupt()`/resume + crash-resume. |
| **Client-fulfilled tools already work** | `dynamic_graph.py:48` `tool_route` edge → `routes["caller"]`; graph returns `state["tool_calls"]`; caller replays as `query_tool_results` (`state.py:66`) | Computer use / client tools need **no** new mechanism. The gap is durability, not client tools. |
| Server tools run **in-graph** | `TOOL_EXECUTOR` loop → `loop_messages` (`state.py:80`); the only registry tool today is `generate_pdf` (`web_search` is a separate node, not a model tool; no `code_execution`) | The agentic loop already exists; DBOS wraps it, doesn't replace it. |
| Persistence today | DynamoDB (graphs: `graph/graph_loader.py`), S3 artifacts (`graph/tools_runtime.py`), Milvus (`requirements.txt` `pymilvus`) | **Postgres is net-new** — DBOS requires it. |
| **Secrets live in graph state** | `RetrievalState.llm_credentials` (`state.py:49`) | Checkpointing state as-is would persist customer API keys → must refactor. |
| Screenshots/images already model S3 refs | `models.py:25` `ToolResultImage(data|s3_key|omitted)` | Large tool results externalize cleanly (keeps checkpoints small). |
| LangGraph version | `langgraph>=1.2` (installed `1.2.11`, `langgraph-checkpoint 4.2.0`) | `interrupt()`, `Command(resume=…)`, Postgres checkpointer available (needs `langgraph-checkpoint-postgres`, not installed today). |
| Runtime | Python 3.11, pip + `requirements.txt`, single `python app.py` uvicorn process (no `--workers`); prod Fly machine **always-on**, **dev scales to zero** (`min_machines_running=0`) | Durable background runs need an always-on worker — dev's scale-to-zero would idle-stop a run mid-flight. |

**Takeaway:** the missing capability is **durable, resumable, reattachable run execution** —
not client tools (already present) and not the agent loop (already present). DBOS supplies
exactly that, as a library on Postgres.

---

## 2. What this adds vs. what already exists

| Capability | Today | After |
|---|---|---|
| Client-fulfilled tools (computer use etc.) | ✅ via `tool_calls`/`query_tool_results` replay | ✅ unchanged (optionally upgraded to in-graph `interrupt()`) |
| Server-side agent loop (`generate_pdf` tool, `web_search` node, artifacts) | ✅ `TOOL_EXECUTOR` + nodes | ✅ unchanged |
| Crash / redeploy mid-run resume | ❌ lost | ✅ LangGraph checkpointer + DBOS recovery |
| Run survives client disconnect (background) | ❌ stream is request-coupled | ✅ DBOS workflow keeps running |
| Reattach to an in-flight run's stream | ❌ | ✅ events channel + replay-from-offset |
| In-graph human-in-the-loop pause | ⚠️ only by exiting the whole graph + replaying | ✅ true `interrupt()` mid-node |
| Exactly-once LLM call across retries | ❌ (retry can double-bill) | ✅ LLM call wrapped as a DBOS step |

---

## 3. Architecture — two durability layers, one Postgres

```
 proxy (Kotlin, holds DDB conversation)
   │  POST /runs (start)   POST /runs/{id}/resume   GET /runs/{id}/stream (reattach)   /cancel
   ▼
 retrieval-server (FastAPI + DBOS library, same process)
   │
   ├── DBOS workflow  ── OUTER run lifecycle ────────────────────────────────┐
   │     • durable background job (survives disconnect/crash/redeploy)         │
   │     • queue + retries + run registry + status                             │  Postgres
   │     • HITL / client-tool wait via DBOS.recv(run_id) ; resume = DBOS.send  │ (net-new)
   │     • wraps each vendor LLM call as a DBOS step (exactly-once)            │
   │                                                                           │
   └── LangGraph graph.astream_events(config={thread_id: run_id})             │
         • INNER graph-state durability via Postgres checkpointer ────────────┘
         • interrupt()/Command(resume) for in-graph pauses
         • events → events channel (Postgres LISTEN/NOTIFY, keyed by run_id, seq)
                         │
                         ▼  SSE relay (subscribe / replay-from-seq on reattach)
                       proxy → client (unchanged NDJSON: c/tc/ks/kd/ws/ga/err)
```

- **DBOS** owns *the run as a durable job*: enqueue, background execution, retry, reattach
  registry, and the resume/HITL signal boundary. It's a library embedded in the existing
  FastAPI process — **no new service**.
- **LangGraph checkpointer** owns *graph state*: per-super-step checkpoints (crash-resume)
  and `interrupt()`.
- Both share the one net-new **Postgres — a managed Supabase database**. `thread_id == run_id`
  ties a checkpoint thread to its DBOS workflow.
- **Redis is not required** — DBOS uses Postgres for its queue/messaging, and stream reattach
  can use Postgres `LISTEN/NOTIFY`. (Redis stays optional if we later want higher-throughput
  fan-out.) Note this makes the Supabase **connection mode** matter — see §4.

---

## 4. Postgres = Supabase (the only new infra)

Decision: use **Supabase** (managed Postgres) for now. It's plain Postgres, so nothing about
the DBOS / checkpointer design changes — but it's managed, so there's **zero DB to run or
babysit on Fly**, which is the whole "least infra" point.

What lives there:
- **DBOS system tables** — workflow/step status, queues, messages (`send`/`recv`), events.
  DBOS creates/migrates these itself on launch.
- **LangGraph checkpoints** — `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`
  (created by `AsyncPostgresSaver.setup()`).

Sizing: modest. The largest channels are `loop_messages` + `conversation_history`; Postgres
TOASTs large rows so the 400 KB-style ceiling is a non-issue. Keep blobs lean by continuing
to store images as S3 refs (`ToolResultImage.s3_key`), never inline base64, in checkpointed
state.

### Supabase-specific setup (the one real gotcha: connection mode)

**Yes — Supabase works as-is. None of the items below are blockers**; they're just
"copy the right connection string from the dashboard + one config flag." No add-on, no special
tier, no self-hosting is required. The list exists so we pick the right string on day one
rather than debug a subtly-broken deploy later.

Supabase exposes the DB three ways, and **which one you use matters** because DBOS, the
checkpointer, and stream reattach all need **session-level** Postgres features:

| Connection | Port | Session features (LISTEN/NOTIFY, advisory locks, prepared stmts) | Use for |
|---|---|---|---|
| Direct connection | 5432 | ✅ full | DBOS + checkpointer + `LISTEN/NOTIFY` |
| Supavisor **session** pooler | 5432 (pooler host) | ✅ full | same, when you need pooling / IPv4 |
| Supavisor **transaction** pooler | 6543 | ❌ breaks LISTEN/NOTIFY, advisory locks, prepared stmts | **do not** use for DBOS/checkpointer/reattach |

- Use the **direct connection or the session-mode pooler** for `DATABASE_URL`. The
  **transaction pooler (6543) will break** `interrupt()`/resume (advisory locks) and the reattach
  channel (`LISTEN/NOTIFY`) — this is the single easiest way to get a subtly broken deploy.
- **SSL is required** — `?sslmode=require` on the connection string.
- **IPv4 from Fly:** Supabase's *direct* connection is IPv6-only; the **Supavisor session
  pooler provides IPv4**. Prefer the session pooler from Fly (or add Supabase's IPv4 add-on) and
  verify egress in the P0 spike.
- **DBOS system database:** DBOS defaults to a *separate* system DB (`<app>_dbos_sys`); Supabase
  gives you one `postgres` database and may not allow `CREATE DATABASE` on lower tiers. Still
  fine — DBOS can put its system tables in a **schema** of the same DB via config; P0 just
  confirms which knob. Worst case is a config flag, not a wall.
- **Connection budget:** managed Postgres caps connections; size the psycopg pool small
  (e.g. 5–10) × instance count under the tier limit, and lean on the session pooler.

**Fly.io:** no Postgres, no Redis, **no new always-on compute** on Fly — DBOS workers *are* the
retrieval-server process; Postgres is Supabase. (Contrast Temporal, which needs a separate
always-on cluster + DB; and the LangGraph Platform, which needs Postgres + Redis + a license.)

---

## 5. Concrete changes, file by file

### 5.1 Dependencies (`requirements.txt`)
```
dbos                              # durable execution (MIT, library on Postgres)
langgraph-checkpoint-postgres     # official LangGraph Postgres saver (AsyncPostgresSaver)
psycopg[binary,pool]              # async Postgres driver used by both
```
> `langgraph-checkpoint 4.2.0` already ships transitively but only provides `InMemorySaver`;
> `langgraph-checkpoint-postgres` adds `AsyncPostgresSaver` on the same 4.x core. The **deployed
> image has no Postgres driver today** (`psycopg2`/`sqlalchemy` exist only in the local venv, not
> in `requirements.txt`), so `psycopg` is genuinely new.

### 5.2 App init (`app.py`)
- Construct the checkpointer once (process singleton) and `.setup()` it on startup.
- Initialize DBOS bound to FastAPI; `DBOS.launch()` runs migrations + recovers interrupted
  workflows on boot (this is what makes redeploy safe).
```python
# app.py (sketch)
from dbos import DBOS
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

CHECKPOINTER = None  # set on startup

@app.on_event("startup")
async def _startup():
    global CHECKPOINTER
    saver_cm = AsyncPostgresSaver.from_conn_string(os.environ["DATABASE_URL"])
    CHECKPOINTER = await saver_cm.__aenter__()
    await CHECKPOINTER.setup()

DBOS(fastapi=app, config={"database_url": os.environ["DATABASE_URL"], "name": "retrieval-server"})
DBOS.launch()
```
> `DATABASE_URL` is the **Supabase session-mode / direct** connection string (port 5432,
> `sslmode=require`) — **not** the transaction pooler (6543), which would break `interrupt()`
> resume and `LISTEN/NOTIFY` reattach (§4). Both DBOS and the checkpointer read the same URL.

### 5.3 Compile with the checkpointer (`graph/dynamic_graph.py`)
- One-line change at `:125`, but with a decision: **when a checkpointer is set, LangGraph
  requires a `thread_id` in `config.configurable` on every invocation.**
  - Recommended: **always pass a `thread_id`** — durable runs use `run_id`; the legacy
    stateless `/retrieve` path passes an ephemeral throwaway id (or we keep a second,
    checkpointer-less compiled variant for `/retrieve`). Keeping two variants avoids writing
    throwaway checkpoints for high-volume stateless calls.
```python
compiled = workflow.compile(checkpointer=CHECKPOINTER)   # durable variant
# and/or
compiled_stateless = workflow.compile()                  # existing /retrieve fast path
```
- The per-customer `_graph_cache` is unaffected — the checkpointer is orthogonal to graph
  identity.

### 5.4 The DBOS run workflow (new `runs.py`)
The heart of the change. One durable workflow per run; it drives the graph and streams.
```python
# runs.py (sketch)
from dbos import DBOS, Queue
run_queue = Queue("agent_runs", concurrency=...)  # bound background concurrency

@DBOS.workflow()
async def agent_run(run_id: str, state: dict, run_cfg: dict):
    cfg = {"configurable": {"thread_id": run_id}, "recursion_limit": run_cfg["max_iterations"]}
    async for event in GRAPH.astream_events(state, config=cfg, version="v2"):
        seq = await _publish(run_id, event)          # append to events channel (durable, ordered)
    # If the graph hit interrupt() (client tool / human input needed):
    #   results = DBOS.recv(topic=run_id)            # durable wait; survives restart
    #   resume via GRAPH.astream_events(Command(resume=results), config=cfg) ...
    return _final_summary()                            # committed-messages, usage, artifacts
```
- **Start**: `run_queue.enqueue(agent_run, run_id, state, cfg)` → returns a handle. The run now
  executes in the background, durably.
- **Exactly-once LLM** (hardening): wrap the vendor call in `graph/nodes/llm_node.py` (the
  `llm.ainvoke` site) as a `@DBOS.step()` so a resume never re-issues a completed LLM call —
  directly addresses the double-bill concern already noted in `graph/llm_factory.py:32`.
- **HITL / client tools**: two options —
  1. Keep today's exit-and-replay (`tool_calls` out, `query_tool_results` in) — zero graph
     change; the DBOS workflow ends and a new one continues. Simplest.
  2. In-graph `interrupt()` inside `TOOL_EXECUTOR`/a new HITL node → `DBOS.recv(run_id)` waits,
     resume endpoint does `DBOS.send(run_id, results)`, graph resumes from the checkpoint.
     Use this when you want a deep pause without unwinding the whole graph.

### 5.5 Credentials: fetch from DDB by `customer_id`, never checkpoint them
Decision (product): resolve BYOK credentials **server-side from DynamoDB, keyed by
`customer_id`** (already KMS-encrypted at rest there) rather than passing them in the request
body. This is the norm unless a perf/cost issue appears.

Two hard rules so durability doesn't leak secrets — they interact with **both** persistence
layers:
- **`llm_credentials` must leave `RetrievalState`** (`state.py:49`) — checkpointed state is
  written to Postgres.
- **Creds must not pass through a DBOS workflow *input* or a `@DBOS.step()` *output*.** DBOS
  persists both to its system tables to enable replay/recovery, so either would re-introduce the
  leak in a different Postgres table. Fetch them in **plain, non-step code** at
  LLM-construction time and hold them in a **runtime-only, per-run cache** keyed by
  `customer_id`, never serialized into state. Only `customer_id` is safe to persist.

Implementation:
- Add a resolver (e.g. `graph/credentials.py`) that reads the encrypted creds row by
  `customer_id` and **KMS-decrypts** it, **memoized per run** so a multi-node/looping graph does
  one DDB+KMS round-trip, not one per node (the graph calls `get_llm` per node —
  `llm_node.py:437` etc.).
- `get_llm(provider, credentials, …)` (`llm_factory.py:39`) is unchanged; only its *caller*
  changes — creds come from the resolver, not from `state["llm_credentials"]`.
- Ops: the retrieval-server needs **read access to the creds table + KMS decrypt** for that key.
  The proxy does this today (`CustomerCredentialsRepository` / `KMSProvider`) — confirm the same
  table/key and grant the retrieval-server's IAM role decrypt. (Fallback if KMS-in-Python is
  undesirable: proxy keeps decrypting and passes creds as a **runtime-only** field the run never
  checkpoints — strictly worse than fetching by `customer_id`.)
- Performance: one DDB read + one KMS decrypt **per run** (cached), negligible next to LLM
  latency.

### 5.6 Stream reattach channel (new small module, e.g. `run_events.py`)
- An `events` table keyed by `(run_id, seq)` with a monotonic `seq` per run.
- `publish(run_id, event)` appends the next `seq`.
- The SSE endpoint **polls** `SELECT ... WHERE run_id=? AND seq > ? ORDER BY seq` on a short
  interval (e.g. 250–500 ms), streaming out new rows; on reconnect the client sends
  `Last-Event-ID`/`?from_seq=` and we replay from there, then keep tailing.
- **Polling, not `LISTEN/NOTIFY`** — P0 proved NOTIFY doesn't work over the Supabase pooler.
  Polling is pooler-safe, needs no Redis and no direct/IPv6 connection, and the added latency
  is bounded by the poll interval. (If sub-100 ms latency ever matters, revisit with a direct
  connection or Redis — not needed now.)

### 5.7 New run API (new `routes/runs.py`) — `/retrieve` stays as-is
| Endpoint | Purpose |
|---|---|
| `POST /runs` | start a durable run → `{run_id}` (enqueue `agent_run`) |
| `GET /runs/{id}/stream` | subscribe / **reattach** (SSE, replay-from-seq) |
| `POST /runs/{id}/resume` | deliver client-tool results / human input → `DBOS.send(id, …)` |
| `POST /runs/{id}/cancel` | cancel workflow + discard checkpoint |
| `GET /runs/{id}` | status/result (for polling / rediscovery) |

Non-durable and internal generations keep the existing stateless `/retrieve` and
`/execute-agent-graph` paths — no regression.

### 5.8 Proxy (Kotlin) changes
- New **run client** alongside `RetrievalServerClient`: `start` / `resume` / `reattach` /
  `cancel`, mapping `conversationId → run_id` (store `run_id` on the conversation record in DDB).
- **Event translation**: the retrieval-server already emits **full-word SSE** keys
  (`content`, `tool_calls`, `thinking_step`, `thinking_duration_ms`, `web_sources`,
  `generated_artifacts`, `error`, `[DONE]` — `streaming.py`); the proxy already maps those to the
  client's NDJSON abbreviations (`c`/`tc`/`ks`/`kd`/`ws`/`ga`/`err`). The `/runs` path **reuses
  that same mapping**, so the web app + example client protocol don't change.
- **Pending-run pointer** on the conversation (DDB) so a page reload rediscovers "assistant is
  mid-run / awaiting your input" and reattaches.
- Keep the proxy as the **conversation system-of-record**: persist committed messages from the
  run's completion events, idempotently keyed by `run_id`/step.

---

## 6. State reconciliation

- **Postgres (DBOS + checkpoint)** = execution state *during* a run; prune or TTL after
  completion (keep briefly for debug/time-travel).
- **DynamoDB conversation (proxy)** = durable transcript, sharing, titles, learned-facts —
  unchanged system-of-record.
- Single writer for messages (the proxy), fed by run events → no dual-write races.
- Pending-run pointer bridges the two so reloads don't lose an in-flight agent.

---

## 7. Phasing (each phase ships independently; nothing regresses)

| Phase | Deliverable | Touches |
|---|---|---|
| **P0 spike** ✅ | Point at a **Supabase** dev project (session-mode URL); DBOS + checkpointer wired; run one graph through `agent_run` with a trivial `interrupt()`; prove crash-resume + reattach; **confirm the §4 Supabase items** (session vs txn pooler, IPv4 from Fly, DBOS system-tables-in-a-schema) | `app.py`, `dynamic_graph.py`, `runs.py`, Supabase project |
| **P1** | `/runs` durable background path for the agentic case (start/stream/cancel) + proxy run client + event translation; **secrets out of state**; `/retrieve` untouched | retrieval-server + proxy |
| &nbsp;&nbsp;• P1a ✅ | Credentials resolved from DDB by `customer_id` (`graph/credentials.py`, `credentials_for`); nodes cut over; secret left out of the durable state | retrieval-server |
| &nbsp;&nbsp;• P1b ✅ | Proxy SSE→`StreamChunk` parser extracted to a shared `parseRetrievalEvent` (reused by the runs client) | proxy |
| &nbsp;&nbsp;• P1c ✅ | Durable `/runs` path: checkpointer compile variant, `run_events` reattach channel, `agent_run` DBOS workflow, `routes/runs.py`; verified over Supabase + in the deployed dev env | retrieval-server |
| &nbsp;&nbsp;• P1d | Kotlin proxy `RunsClient` (start/reattach/resume/cancel/status) + wire one flow behind a flag; `conversationId → run_id` pointer for reload rediscovery | proxy |
| **P2** | exactly-once LLM step; in-graph `interrupt()` for HITL/client tools; resume via `DBOS.send`; pending-run pointer + reload rediscovery | `llm_node.py`, `tool_executor.py`, proxy |
| **P3** | queue concurrency/priorities, retry/backoff policy, run inspection + metrics, cron/scheduled agents (DBOS scheduled workflows) if wanted | runs/observability |

---

## 8. Fly.io footprint

- **Zero new infra on Fly.** Postgres is **Supabase** (managed, off-Fly); no Redis; no new
  always-on compute — DBOS workers are the existing retrieval-server process. (Optionally split a
  dedicated worker process later for heavy background load; not needed to start.)
- The only new external dependency is the **Supabase database** and the retrieval-server's
  outbound connection to it (session-mode, §4).
- Background runs need an always-on worker. **Prod is already always-on**, so this is a
  non-issue there (dev scales to zero and would idle-stop a run, but dev is out of scope). DBOS
  resumes interrupted workflows when the process restarts.
- Net: the **least-infra durable option** — a managed Supabase DB and nothing else, vs.
  Temporal's cluster+DB, vs. the Platform's Postgres+Redis+license.

---

## 9. Risks / decisions to lock before P1

1. **Secrets never in Postgres** — creds fetched from DDB by `customer_id` (KMS-decrypted), held
   in a runtime-only per-run cache; must NOT enter `RetrievalState`, DBOS workflow inputs, or
   `@DBOS.step()` outputs (all three get checkpointed). Land this before enabling durable runs.
   (§5.5)
2. **thread_id policy** — always-thread_id vs. a separate checkpointer-less compiled graph for
   `/retrieve` (recommended: keep both variants; don't checkpoint high-volume stateless calls).
3. **Async compatibility** — the graph is async (`astream_events`, `ainvoke`); use DBOS async
   workflows/steps and `AsyncPostgresSaver`. Verify DBOS async support against the pinned
   version in the P0 spike.
4. **Checkpoint growth** — keep images as S3 refs; consider pruning `loop_messages` for very
   long runs.
5. **Exactly-once** — wrap the vendor call as a DBOS step to avoid double-billing on
   resume/retry (the codebase already avoids app-layer retries for this reason).
6. **Recovery ownership** — with multiple retrieval-server instances, DBOS recovers orphaned
   workflows via Postgres; confirm the recovery/executor config so a redeploy resumes runs.
7. **Coupling** — DBOS is a library (MIT), low lock-in; the LangGraph checkpointer is the
   official saver. Both are swappable later. Supabase is plain Postgres, so it's swappable for
   any Postgres (RDS/Neon/Fly PG) with only a connection-string change.
8. **Supabase connection mode** (§4) — DBOS, `interrupt()` resume, and `LISTEN/NOTIFY` reattach
   need a **session-capable** connection; the transaction pooler (6543) breaks them. Lock in the
   session/direct URL, `sslmode=require`, IPv4 reachability from Fly, and whether DBOS's system
   tables can live in a schema of the single Supabase `postgres` DB — all verified in P0.

---

## 10. Rough effort

P0 ≈ 1 week (spike + de-risk). P1 ≈ 2–3 weeks (retrieval-server + proxy, incl. secrets
refactor + event translation). P2 ≈ 2 weeks. P3 ongoing. The proxy event-translation layer and
the secrets-out-of-state refactor are the two biggest line items; everything else is additive.
