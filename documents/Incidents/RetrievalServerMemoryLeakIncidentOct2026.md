# Incident Report: Retrieval Server Memory Leak → Recurring OOM Kills (October 2026)

| | |
|---|---|
| **Incident window** | 2026-10-25 17:56 UTC → ongoing (leak is live in prod until the fix deploys) |
| **Report date** | 2026-10-29 |
| **Status** | Root cause confirmed. **§8 remediation implemented 2026-10-29** on `development` (uncommitted; publish + deploys pending). §9/§10 pending |
| **Severity** | SEV-2 — recurring, user-visible generation failures; self-recovering; no data loss |
| **Affected service** | `genai-retrieval-server-production` (Fly.io, iad, single machine) |
| **Blast radius** | Every in-flight chat generation routed through `genai-proxy-server` dies when a kill lands |
| **Investigation trigger** | Conversation `690e54ae-ba09-4b15-8ba8-d9883514d986` (customer `CU92726CAF17F6`) died mid-generation at 2026-10-29 03:45 UTC with no assistant reply |

---

## 1. TL;DR

- Since the **2026-10-25 17:56 UTC deploy**, the retrieval server leaks **~31 MB on every Voyage embedding call** and gets OOM-killed every few hours.
- Commit `0170cab8` ("remove platform-wide fallback keys") removed the **process-lifetime cache for hosted embedding clients** — a fresh `VoyageAIEmbeddings` client is now constructed per call so each customer's own API key is used. The security goal was right; the implementation chose "no cache" instead of "cache keyed by customer/key".
- The construction itself is cheap. The retention is an **upstream bug in the `voyageai` SDK (0.5.0)**: `@functools.lru_cache()` on an *instance method* (`BaseClient.tokenizer`) pins every client — plus a **~31 MB HuggingFace Rust tokenizer per client** — in a class-level cache (maxsize 128 ≈ 4 GB of potential retention on a 2 GB VM).
- Every chat turn makes 1–3 such calls (memory recall, knowledge-base search, memory encode) → RSS climbs ~5–10 MB per turn → hits the VM ceiling in hours → the kernel kills `python` → **all in-flight generations fail** with `transport_error` ("Connection to the retrieval server was lost mid-response").
- The 2026-10-25 RAM bump (1024 MB → 2048 MB) was a stopgap taken before the root cause was known; the leak outpaced it. **~10–12 OOM kills in 4 days.**
- **Approved fix (pending implementation):** restore caching at the choke point, keyed by `(model_type, model_name, sha256(api_key))` — client reuse is back, and cross-customer key reuse is structurally impossible.

---

## 2. User impact

- **Failed conversations:** any generation streaming at the moment of an OOM kill dies mid-response. The proxy logs `Generation … failed mid-stream (transport_error)` and the user sees a conversation with their message but **no assistant reply**.
  - Triggering example: customer `CU92726CAF17F6` asked a question at 03:44:47 UTC on 2026-10-29 (model `gpt-5.6-sol`, high thinking); both generation attempts (`22ebf60a…`, `f443e522…`) died at 03:45:24 when the server was OOM-killed 37 seconds into the turn.
- **Hard downtime per kill:** ~30–60 s (health-check failure → SIGKILL → Firecracker reboot → app boot). Fly's restart policy recovers the machine automatically.
- **Collateral per kill:** in-flight memory extraction, title generation, and note encoding on the box also die.
- **Frequency:**
  - Oct 25 evening (1 GB VM): kills every ~0.5–3.5 h.
  - Oct 26–29 (2 GB VM): kills every ~4–22 h depending on traffic.
- **Secondary degradation:** each fresh client may hit the HF Hub anonymously (prod logs the "unauthenticated requests to the HF Hub" warning), risking rate-limit slowness on embed paths.
- No data was lost: user messages persist in DynamoDB; only the assistant responses failed.

---

## 3. Timeline (all UTC)

| When | What happened |
|---|---|
| 2026-09 | VMs right-sized to shared-cpu-1x / **1024 MB** after torch removal (embeddings became API-backed) |
| 10-25 16:45 | Commit `0170cab8` lands (encoding-library **0.1.37**): per-customer embedding keys; hosted embedding clients no longer cached |
| 10-25 17:24, 17:43 | PR #264 / #266 prod deploys **fail** in CI (stale-layer pin attempts) — leak not yet live |
| 10-25 17:56 | **PR #267 deploys successfully** — first `--no-cache` image, carries 0.1.37. Leak goes live |
| 10-25 18:01 | First leaky process starts; RSS slope **+992 MB/h**; OOM-killed within ~27 min |
| 10-25 evening | OOM-kill loop every ~0.5–3.5 h. **Stopgap:** VM bumped 1024 → 2048 MB ("root cause still open" noted in `fly.production.toml`). No tracking issue or alert created |
| 10-26 05:00 | Fly host migration replaces the machine (`8040d1…` → `784ee9…`); leak persists |
| 10-26 18:35 | PR #273 deploys (encoding-library 0.1.38, usage rollup); leak persists — expected, the bug is in 0.1.37's change which is still present |
| 10-27 | Three OOM kills (process starts 01:53, 06:12, 15:33) |
| 10-28 14:13 | Graceful Fly host restart (SIGINT, clean exit — not an OOM) |
| 10-29 03:44:47 | Customer message arrives in conversation `690e54ae…` |
| 10-29 03:45:11 | Fly health check fails (memory pressure) |
| 10-29 03:45:24 | Kernel OOM-kills `python` (`anon-rss: 1,888,284 kB` ≈ 1.8 GiB against the 2 GB ceiling). Both in-flight generation attempts fail with `transport_error`. Machine reboots, healthy ~03:48 |
| 10-29 | User reports the failed conversation → this investigation root-causes the leak. Fix designed and approved |

- Detection gap worth noting: **symptom** noticed within hours on Oct 25 (hence the RAM bump), but the **root cause** stayed open ~3.5 days and was only found after a user-reported failure. No alert ever fired — there were none.

---

## 4. Root cause

The failure chain, in order:

1. **Code change:** `0170cab8` replaced `_get_cached_embedding_model` (a process-lifetime cache keyed by model) with `customer_embedding_model` (`retrieval-server/graph/nodes/retrieval.py`). Local sentence-transformer models stayed cached; **hosted models (Voyage/OpenAI) are now constructed fresh on every call** via `get_embedding_model_for_customer`, so one customer's keyed client can never serve another customer.
   - The docstring called hosted clients "cheap API wrappers built per call" — an assumption that was never measured.
2. **Call sites — this runs constantly:**
   - `graph/nodes/memory.py:127` — memory recall, every chat turn (one per embedding-model group)
   - `graph/nodes/retrieval.py:114` — knowledge-base search (when invoked)
   - `routes/search.py:151` — unified search
   - `routes/notes.py:181` — `/encode-memory` (memory writes after turns)
   - The **encoding-server lambdas** inherited the same per-call pattern; warm Lambda containers accumulate across invocations too.
3. **Upstream bug:** `langchain_voyageai.embed_query` → `voyageai.Client.embed` counts tokens **before** the HTTP request via `BaseClient.tokenizer(model)`. In `voyageai/_base.py` (v0.5.0):

   ```python
   @functools.lru_cache()            # cache lives at CLASS level, keyed by (self, model)
   def tokenizer(self, model: str):
       ...
       tokenizer = Tokenizer.from_pretrained(f"voyageai/{model}")   # ~31 MB Rust tokenizer
   ```

   `lru_cache` on an **instance method** keys the class-level cache by `(self, model)`. Every fresh client that embeds inserts a new entry, pinning **both the client object and its own ~31 MB tokenizer** forever (default maxsize 128 ≈ 4 GB potential). The pre-commit cached client loaded exactly one tokenizer per model for the life of the process.
4. **Measured cost:** **+31.3 MB per embed call**, perfectly linear (3.67 GB after 120 calls in an isolated container). The tokenizer loads even when the API call fails — retention is independent of embed success.
5. **Paths that do NOT leak** (explains why the fleet-average slope is ~5 MB per recall rather than 31 MB):
   - OpenAI embeddings: fresh-per-call is wasteful (TLS/client churn) but plateaus after a one-time ~22 MB — no linear growth.
   - Voyage contextualized models (`voyage-context-*`): our own raw-HTTP encoder, never touches the voyageai SDK or its tokenizer.
   - Sentence-transformer models: still cached by the commit.
6. **Death spiral:** request-driven growth → 2 GB ceiling in hours under traffic → kernel OOM kill → Fly reboot → every active stream on the single machine dies → proxy surfaces `transport_error` to users.

---

## 5. How it was identified (investigation steps)

1. **Pinned the symptom.** The failed conversation's two generation attempts died with `ClosedByteChannelException` / `transport_error` in proxy logs at 03:45:24; retrieval-server logs showed a kernel OOM kill at the exact same second. Question became "why does RSS grow".
2. **Got history, not snapshots.** Fly's log buffer is minutes-shallow, but **Fly's managed Prometheus holds weeks of metrics**. Pulled 21 days of `process_resident_memory_bytes` + `process_start_time_seconds` and segmented RSS **per process lifetime**.
   - Result: processes flat for weeks (+0.1 to +8.8 MB/h over 10–78 h lifetimes, ending < 820 MB), then **every process after Oct 25 ~18:00 leaks (+25 to +992 MB/h)** and dies at the ceiling. A leak with a birth date is a regression, not a mystery.
3. **Mapped the birth date to a deploy.** GitHub Actions history × Fly releases: PR #262's process (15:58) was clean; PR #267's (18:01) OOM'd in 27 minutes. Everything differing between those two images became the suspect set.
4. **Split code-delta from dependency-delta.** PR #267 was also the first `--no-cache` build, so ~25 dependencies re-resolved at the same moment. Pulled **both actual images from the Fly registry** and diffed `pip freeze`: one code change (encoding-library 0.1.36 → 0.1.37, i.e. `0170cab8`) + a handful of version bumps.
5. **Profiled the leak's shape to constrain the mechanism.**
   - Zero-traffic hours grew **exactly 0.0 MB** → strictly request-driven, no background task.
   - File descriptors (17–42) and threads (15) flat while RSS climbed → not sockets/threads/connections; pure anonymous heap.
   - `python_gc_objects_uncollectable_total` = 0 → not an uncollectable-cycle leak.
   - Prometheus exposition trivial (285 series, 32 KB) → not metric cardinality.
   - Hourly regression: growth correlates with request counters (~5.5 MB per memory-recall op fleet-wide).
6. **Reproduced in isolation.** The one hot-path behavior change in `0170cab8` was "stop caching hosted embedding clients". Benchmarked exactly that in `python:3.11-slim`:

   | Scenario | Result |
   |---|---|
   | Fresh `VoyageAIEmbeddings` + embed per call *(current prod)* | **+31.3 MB/call, linear — 3.67 GB after 120 calls** |
   | Cached Voyage instance reused *(pre-commit)* | +55 MB once (one tokenizer), then flat |
   | Fresh `OpenAIEmbeddings` + embed per call | +22 MB one-time plateau, then flat |
   | Cached OpenAI instance | flat |
   | Construct-only, no embed (Voyage) | flat — the tokenizer pins on first *embed*, not construction |

7. **Found the retention point and its prod fingerprint.** Read voyageai's source → the `lru_cache`-on-method. The matching fingerprint — huggingface_hub's "unauthenticated requests" warning — appears in prod logs minutes after every boot, including 03:48 on Oct 29, right after the OOM restart.

---

## 6. Alternatives considered and ruled out

| Hypothesis | Why it's not the cause |
|---|---|
| pymilvus connection/channel registry | Identical version (3.0.2) in clean **and** leaky images; clean image ran the same Milvus traffic flat for weeks; a channel leak accumulates fds/threads — both flat. (pymilvus ≥ 2.5 dedupes channels per `(endpoint, token)`; clients are still never closed — kept as a slow co-factor, see §8.3) |
| Run/stream registries, DBOS internals, Postgres checkpointer, image pipeline | Audited clean — Postgres-backed with TTL pruning, ref-counted and popped, or byte-capped LRUs with eviction |
| Usage-rollup accumulation (0.1.38) | Landed 18:55 UTC — **after** leak onset (18:01); writes straight to DynamoDB, no in-process buffering; leak persists identically on the 0.1.38 image |
| starlette 1.9→1.10 / fastapi / sse-starlette bumps | Idle health checks hammer the app all night with zero growth; starlette 1.10's changelog is a memory-leak *fix*, not a regression |
| Prometheus client cardinality | 285 series, 32 KB exposition — trivial |
| GC cycles / uncollectable objects | `python_gc_objects_uncollectable_total` = 0 across all generations |
| First-party caches (graph, memory, instruction caches) | Audited — all bounded or refresh-in-place (see §8.3 for their separate, slower issues); none scale with per-request anon heap |
| langchain-core 1.6→1.7, jiter, websockets bumps | Nothing matches a request-proportional anon-heap signature; kept as **fallback suspects** — if the fix deploy doesn't flatten the slope, look here next |

Residual uncertainty, stated honestly: full prod traffic was not replayed against both images. The fix deploy is the final experiment — expected outcome is a return to the pre-Oct-25 profile (flat ~300–800 MB, < 6 MB/h).

---

## 7. Contributing factors

- **Unmeasured assumption:** "hosted clients are cheap API wrappers" was written into a docstring and never benchmarked. The real cost was 31 MB/call because of a third-party bug.
- **Upstream antipattern:** `functools.lru_cache` on an instance method (voyageai SDK) turned "wasteful" into "unbounded".
- **Unpinned dependencies + `--no-cache` coupling:** requirements are floor-pins (`>=`), so the first `--no-cache` build re-resolved ~25 packages in the same image as the code change — bisection required pulling registry images.
- **No memory observability:** no RSS/restart/OOM alerts existed. Detection came from a user bug report 3.5 days after onset.
- **Stopgap without a leash:** the RAM bump shipped with a "root cause still open" comment but no tracking issue and no alert to fire if the problem persisted. It silently became the status quo.
- **Shallow log retention:** Fly's log buffer holds minutes-to-hours; nothing ships logs to durable storage. CloudWatch only has the dead ECS-era groups (pre-July 2026) and the lambdas.
- **Single-machine prod:** one VM means every kill takes down all in-flight requests. (Not the cause, but it set the blast radius.)

---

## 8. Remediation

### 8.1 The fix (implemented 2026-10-29 — encoding-library 0.1.39, uncommitted)

- Restore caching at the choke point, in **encoding-library** so retrieval-server and the encoding lambdas both get it:
  - Cache clients keyed by `(model_type, model_name, sha256(api_key))` in a small, lock-guarded, bounded LRU (~32 entries).
  - Keying by key-hash preserves the security goal **structurally**: a rotated key creates a new client; two customers share a client only if their credentials are literally identical — in which case there is nothing to leak.
  - Keep per-call DynamoDB+KMS key resolution, or give it a short (~5 min) TTL cache so rotations propagate fast while killing per-embed KMS churn.
  - Tests: same key+model → identical instance; rotated key → new instance; LRU bound respected.
- Ship as encoding-library **0.1.39**, repin consumers, deploy retrieval-server (rides the proxy-server workflow) and rebuild the encoding lambda images.
- Pin `voyageai` in requirements and **file the bug upstream** (suggest a module-level cache keyed by model only).
- **Validation:** watch `process_resident_memory_bytes` for 24 h post-deploy. Expect flat ~300–800 MB. After a few clean days, downsize the VM 2048 → 1024 MB and remove the stopgap comment.

Implementation notes (as built, vs. the spec above):

- Cache key is `(model_type, model_name, sha256(api_key), sha256(hf_token))` in `embedding_utils.get_embedding_model` — LRU of 32, lock-guarded, client built outside the lock. 15 new tests in `encoding-library/tests/test_embedding_client_cache.py`.
- **Stronger than planned:** each cached Voyage client gets its tokenizer pre-loaded once and pinned to the client *instance*, shadowing voyageai's class-level `lru_cache` — so the upstream bug is bypassed entirely (an evicted client frees its tokenizer) rather than merely bounded. Preload failure degrades to the SDK's lazy load.
- Per-call DynamoDB+KMS key resolution kept (no TTL cache): rotation is instantaneous and simply misses the client cache.
- `voyageai>=0.5.0,<0.6` pinned in encoding-library; version bumped to 0.1.39; all four consumer pins updated (retrieval-server + 3 encoding-server requirement files).
- Upstream bug report drafted at `documents/Incidents/VoyageaiTokenizerLruCacheUpstreamIssueDraft.md` — **not yet filed** (needs a human decision to post publicly).

### 8.2 Hugging Face tokens (decided and implemented 2026-10-29)

- HF tokens become a **per-customer, bring-your-own credential** — same model as Voyage/Tavily keys — collected in the **first-time onboarding (FTUE) wizard** and editable in Settings; stored KMS-encrypted alongside the other vendor credentials.
- Used for HF Hub fetches (tokenizer downloads) attributable to that customer's embedding usage.
- Implementation caution: the voyageai SDK reads ambient HF credentials from the environment. **Never export one customer's token as process-wide `HF_TOKEN` on the shared server** — same isolation rule the probe endpoint already documents for embed keys. Pass tokens explicitly/scoped. With the client cache in place, tokenizer fetches drop to ~once per model per process, so anonymous fallback stays acceptable for customers who don't provide one.

As built:

- Stored as `aiVendor = "HUGGINGFACE"` in CustomerVendorApiKeys (hard contract shared by Kotlin and Python). Kotlin: `EmbeddingVendor.HUGGINGFACE` with `embeds = false` — stored unvalidated (it's a Hub download token, nothing to probe), and excluded from every AI-vendor surface (generation/failover key lists, model catalogs, the weekly embed-probe sweep — each iteration site audited).
- New `DELETE /api/v1/embedding-keys/{vendor}` endpoint, deliberately restricted to HUGGINGFACE (the OPENAI row doubles as the LLM key; VOYAGE backs stored embedding preferences — neither was deletable before and stays that way).
- UI: optional field on the onboarding wizard's Voyage step (skipping never blocks completion) and a managed row with save/remove in Settings → Embedding keys.
- Python: `vendor_keys.get_customer_hf_token()` — optional-credential semantics: a credentials-store failure degrades to None (anonymous download) instead of failing the embed, unlike embedding keys; fetched only for standard Voyage models (the only tokenizer-downloading path) and passed per client instance, never via the environment.

### 8.3 Secondary memory issues (implemented 2026-10-29, except the last item — found in the same code audit; none of them produce this leak's slope)

- **Milvus client lifecycle:** `get_milvus_client` builds a `MilvusClient` per operation and nothing in the repo ever calls `.close()`. pymilvus ≥ 2.5 dedupes the underlying gRPC channel per `(endpoint, token)`, so retention is one channel per customer cluster **plus one per credential rotation** — slow but unbounded. Apply the same keyed-cache/reuse pattern as the embedding fix (or close clients explicitly).
- **Voice registry:** `voice/call_control.py` — `_registry` entries are only removed by explicit `detach()`; a call that ends because the remote side closes the WebSocket (or the reader errors) leaves its `CallControl` behind forever. Add a disconnect hook plus an idle-TTL sweep.
- **Unbounded module-level caches (~8 dicts)** — TTL refreshes in place, but entries are **never evicted**, so growth ∝ customers/graphs/instructions ever touched since boot. Add max-size + eviction:
  - `graph/nodes/memory.py` — `_memory_cache` (full memory rows per customer; the largest of the group) and `_collection_cache`
  - `graph/dynamic_graph.py` — `_graph_cache` and `_durable_graph_cache` (two compiled LangGraph objects per key)
  - `graph/graph_loader.py` — `_graph_cache`; `graph/customer_tools.py` — `_cache`
  - `graph/instruction_loader.py` — `_pinned_cache` (immutable-by-design, grows with every (instruction, version) ever referenced; entries are full prompt texts) and `_latest_cache`
- **Streaming disconnects:** `streaming.py` (~line 573) — `finally: yield "data: [DONE]"` raises `RuntimeError` when the client has disconnected, deferring cleanup of the run's message/state graph to GC. Emit `[DONE]` on normal completion only; clean up immediately on disconnect.
- **Metric label cardinality:** `llm_request_total`/`llm_tokens_total` (`model` label) and `tool_execution_total` (`tool` label) carry request-controlled strings — a BYOK model typo or customer-defined tool name mints permanent time series (prometheus_client never frees label children). Sanitize or allowlist label values.
- **Per-call chat-LLM clients** (`graph/llm_factory.py`): gemini, the nine native providers, and ChatLiteLLM build per-instance transports on every node invocation. Collectible (not a true leak), but the constant SSL-context/pool churn fragments the heap on a small VM. Fold into the same client-reuse pass where practical — lowest priority of this list. **Deliberately deferred** (the only §8 item not implemented 2026-10-29): collectible churn, not retention, and the client-construction paths carry per-request thinking/beta config that makes keyed reuse non-trivial.

Implementation status (2026-10-29), all uncommitted on `development`:

- **Milvus:** connections cached per `(endpoint, sha256(token))` — the identity pymilvus dedupes channels on — bounded at 64 with close-on-evict (safe because every construction flows through the cache, so an evicted entry is its alias's only owner). Rotation retires the old channel instead of leaking it. Per-customer retry/usage proxy unchanged.
- **Voice:** every termination path reaps `_registry` (identity-safe discard from detach/close/reader-finally) plus a 1 h idle sweep on attach. Behavior change, verified safe: post-close `/voice/calls/status`·`detach` now return "Unknown call" — voice usage is persisted per-turn in `VoiceSessionService`, never from the post-mortem registry summary, so billing is unaffected.
- **Module caches:** all 8 dicts swapped to a shared lock-guarded `BoundedCache` (`retrieval-server/graph/bounded_cache.py`) with LRU + real TTL eviction; every TTL duration, stale-serve path (`graph_stale_serve_total`), and invalidation site preserved (each grep hit accounted for). `_pinned_cache` is LRU-only (entries immutable by design).
- **Streaming:** `[DONE]` emitted on normal completion and before propagating internal errors, but never during `GeneratorExit` — client disconnect now closes the generator cleanly.
- **Metric labels:** shared `_clean()` path sanitizes values (printable, ≤64 chars) and caps each label name at 50 distinct values (overflow → `"other"`) — protects both the Prometheus and Lambda EMF backends.
- **Verification:** encoding-library 41 passed/1 skipped (incl. 25 new cache/key tests); retrieval-server full suite 691 passed/2 skipped (1 pre-existing Linux-only failure, identical on a clean tree); Kotlin `./gradlew test` 371 tests 0 failures; React 45/45 + new service tests, `tsc --noEmit` clean.

---

## 9. Preventing this class of bug

- **Lock dependencies.** Adopt a lockfile (`uv lock` / pip-tools) for retrieval-server, encoding-server, and encoding-library consumers. Dependency updates become deliberate, reviewable diffs. Keep `--no-cache` builds (correctness) — safe once pinned.
- **Lint for the exact antipattern:** enable ruff/flake8-bugbear **B019** (`lru_cache` on methods) in Python CI. It can't catch the bug inside a vendor SDK, but it stops us writing the same one.
- **Review heuristics (add to review checklist):**
  - Removing or weakening any cache is a **perf-sensitive change** — demands a measurement, not a docstring assertion.
  - Constructing a third-party SDK client per-call is **presumed expensive until benchmarked**.
- **Stopgaps carry a leash:** any mitigation that masks a defect (RAM bump, retry loop, timeout raise) must ship with a tracked follow-up issue **and** an alert that fires if the underlying defect persists.
- **Post-deploy soak check:** first-hour RSS slope after every prod deploy, compared against the trailing baseline (dashboard panel + annotation; see §10). This would have flagged the leak on day one — the first leaky process OOM'd in 27 minutes.
- **CI records image provenance:** have the build step archive `pip freeze` output per image as a build artifact, so "what changed between deploys" is a text diff instead of registry-image forensics.

---

## 10. Observability changes (proposed)

### Alerts (Grafana, sourced from `observability/grafana/` per repo convention)

- **Memory headroom low:** `fly_instance_memory_mem_available / fly_instance_memory_mem_total < 0.15` for 30 m → warn; `< 0.08` → page. (This alone would have caught this incident within hours instead of days.)
- **Process restart churn:** `changes(process_start_time_seconds[24h]) > 2` → warn. Deploys annotate dashboards, so expected restarts are explainable at a glance.
- **Sustained RSS growth (slow-leak catcher):** `deriv(process_resident_memory_bytes[3h]) > ~20 MB/h` sustained 6 h → ticket, well before any OOM.

Failing generations and API calls (pages on *user pain* even when the cause is novel):

- **Generation failures (proxy) — needs a new counter first.** `GenerationOrchestrator` today only *logs* `Generation … failed mid-stream (<kind>)`; there is no metric, so this incident was invisible to dashboards. Add `generation_failure_total{kind}` (kind = `transport_error`, `rate_limit`, `model_not_found`, `provider_error`, …) at that log site, then:
  - any sustained nonzero `transport_error` rate → **page** (this incident's exact signature — it means the retrieval server died mid-stream);
  - failure share `generation_failure_total / generations > ~5%` over 15 m → warn (catches rate-limit storms, dead models, bad keys).
- **Why HTTP-status alerts alone can't catch this:** a mid-stream death happens *after* the response started streaming as a 200 — it never becomes a 5xx. That's exactly why the counter above is required; the 5xx alerts below are complementary, not a substitute.
- **HTTP 5xx rate, both apps:** proxy `ktor_http_server_requests_seconds_count{status=~"5.."}` (status label already on the dashboards) and retrieval-server `http_requests_total{status=~"5.."}` — sustained elevated rate or >~2% of requests for 10 m → warn.
- **Retrieval-server stream errors:** `rate(stream_error_total) > 0` sustained 10 m → warn (already exported; fired during this incident window).
- **LLM call failures:** share of `llm_request_total{status!="ok"}` per vendor > ~10% over 15 m → warn (vendor outage / exhausted key, distinct from our own 5xx).
- **Dependency retry exhaustion:** `retry_exhausted_total{operation}` (milvus / voyage / tavily — already emitted by `encoding_library.utils.retry`) sustained nonzero → warn; it fires when a dependency is down *before* users notice.

### Dashboards

- Fly backend dashboard additions: per-process RSS with **deploy annotations**, restart-count stat, fd/thread panels (already exported by default collectors), and a "first-2h RSS slope per deploy" soak panel.

### Logs

- **Ship Fly logs to durable storage.** Today the only prod log history is Fly's shallow buffer — this investigation had metrics but nearly no log history. Deploy `fly-log-shipper` (or Vector) forwarding all org apps to Grafana Cloud Loki with ~30 d retention. Then add a log-based alert on the kernel pattern `Out of memory: Killed process`.

### Debug tooling

- Optional, env-gated `/debug/memory` endpoint (tracemalloc top-N + gc stats), enabled via a Fly secret only during an investigation window. Gives allocation-site attribution next time the slope's *cause* isn't obvious from metrics alone.

---

## 11. Debugging runbook — "generations are failing / suspected memory problem"

1. **Was it an OOM?** (fastest check; the buffer is shallow, so do this early)
   ```bash
   fly logs -a genai-retrieval-server-production --no-tail | grep -iE "out of memory|oom|sigkill|health check"
   fly machine list -a genai-retrieval-server-production
   fly machine status <machine-id> -a genai-retrieval-server-production -d   # event history: exit codes, oom_killed flag
   ```
2. **Correlate with the proxy symptom:** proxy logs `Generation <id> failed mid-stream (transport_error): Connection to the retrieval server was lost mid-response` at the same timestamp (`fly logs -a genai-proxy-server-production --no-tail`).
3. **Pull memory history — Fly's managed Prometheus keeps weeks of it.** Gotcha: auth header is `FlyV1`, not `Bearer`.
   ```bash
   TOKEN=$(fly auth token)
   curl -s -G "https://api.fly.io/prometheus/genflowly/api/v1/query_range" \
     -H "Authorization: FlyV1 $TOKEN" \
     --data-urlencode 'query=process_resident_memory_bytes{app="genai-retrieval-server-production"}' \
     --data-urlencode "start=$(date -v-7d +%s)" --data-urlencode "end=$(date +%s)" \
     --data-urlencode "step=600"
   ```
   - Restart detection: query `process_start_time_seconds` — every value change is a new process. Segment RSS per process and fit slopes; **compare slopes before/after each deploy**.
   - Useful: `deriv(process_resident_memory_bytes[2h])` (growth rate), `fly_instance_memory_mem_available` (headroom), `process_open_fds` (socket leaks), `python_gc_objects_uncollectable_total` (cycle leaks).
4. **Inspect the live process** (no pgrep/ps in the image — walk /proc):
   ```bash
   fly ssh console -a genai-retrieval-server-production \
     -C "sh -c 'for p in /proc/[0-9]*/status; do d=$(dirname $p); grep -aq app.py $d/cmdline 2>/dev/null && grep -E \"^(VmRSS|Threads|FDSize)\" $p; done'"
   fly proxy 15001:5001 -a genai-retrieval-server-production &   # then: curl localhost:15001/metrics
   ```
5. **Attribute to a deploy:** match Prometheus restart times against CI and releases:
   ```bash
   gh run list --workflow prod-proxy-server.yml --limit 20 \
     --json createdAt,conclusion,headSha --jq '.[] | "\(.createdAt) \(.conclusion) \(.headSha[0:9])"'
   fly releases -a genai-retrieval-server-production
   ```
6. **Diff the images, not just the code** (deps re-resolve on every `--no-cache` build):
   ```bash
   fly auth docker
   docker pull registry.fly.io/genai-retrieval-server-production:deployment-<GOOD>
   docker pull registry.fly.io/genai-retrieval-server-production:deployment-<BAD>
   docker run --rm <image> pip freeze > freeze_<tag>.txt   # then diff the two
   ```
7. **Reproduce the suspect in isolation** — benchmark only the behavior that changed, in a prod-matched container (see Appendix C for the harness that nailed this one).
8. **Shape heuristics** (what the signals mean):
   - Growth only during traffic, flat when idle → per-request retention.
   - fds/threads flat while RSS climbs → anonymous heap (objects), not sockets/threads.
   - `gc_objects_uncollectable` = 0 → something *holds references* (a cache/registry), not a cycle bug.

---

## 12. Appendices

### A. Per-process RSS slopes (Fly Prometheus, 21-day window)

Before the Oct 25 17:56 deploy (encoding-library ≤ 0.1.36):

| Process start | Lifetime | RSS start → end | Fitted slope |
|---|---|---|---|
| 10-16 19:33 | 34.5 h | 480 → 813 MB | +5.8 MB/h |
| 10-18 16:13 | 36.5 h | 599 → 566 MB | +0.1 MB/h |
| 10-20 04:55 | 16.2 h | 495 → 544 MB | +1.7 MB/h |
| 10-21 03:44 | 10.5 h | 338 → 539 MB | +5.0 MB/h |
| 10-22 19:55 | 48.5 h | 316 → 534 MB | +0.6 MB/h |
| 10-24 20:39 | 9.7 h | 316 → 479 MB | +2.1 MB/h |
| 10-25 15:58 *(PR #262 — last clean image)* | 1.3 h | 466 → 471 MB | +4.6 MB/h |

After (first 0.1.37 image, PR #267):

| Process start | Lifetime | RSS start → end | Fitted slope |
|---|---|---|---|
| 10-25 18:01 | **27 min → OOM** | 579 → 743 MB | **+992 MB/h** |
| 10-25 18:28 | ~54 min → OOM | 233 → 765 MB | +606 MB/h |
| 10-25 20:14 | ~1 h → OOM | 319 → 794 MB | +409 MB/h |
| 10-25 21:33 | ~3 h → OOM | 543 → 808 MB | +126 MB/h |
| *(VM bumped 1024 → 2048 MB)* | | | |
| 10-26 05:03 | 13.3 h | 319 → 1373 MB | +25 MB/h |
| 10-26 18:35 *(PR #273 deploy)* | 7.2 h → OOM | 318 → 1829 MB | +233 MB/h |
| 10-27 01:53 | 4.2 h → OOM | 547 → 1835 MB | +273 MB/h |
| 10-27 06:12 | 9.2 h → OOM | 373 → 1833 MB | +69 MB/h |
| 10-27 15:33 | 22.5 h *(ended by host maintenance)* | 233 → 1139 MB | +31 MB/h |
| 10-28 14:13 | 13.5 h → **OOM 10-29 03:45 (triggering incident)** | 189 → 1764 MB | +114 MB/h |

- Slope varies with the share of standard-Voyage embed traffic (OpenAI / contextualized-Voyage / sentence-transformer paths don't leak). Idle hours: exactly 0.0 MB growth.

### B. Image diff (clean PR #262 vs leaky PR #267, via registry `pip freeze`)

- The code change: `genflowly-encoding-library 0.1.36 → 0.1.37` (contains `0170cab8`).
- **Unchanged:** `pymilvus 3.0.2` (exonerates the Milvus-registry theory).
- Bumped alongside (investigated, not the cause): `starlette 1.9→1.10`, `fastapi 0.158.1→0.162.0`, `langchain-core 1.6.12→1.7.0`, `jiter 0.17→0.18`, `websockets 16.1.1→17.3`, `litellm 1.106.2→1.106.4`, plus ~20 minor bumps.

### C. Isolated reproduction (the decisive experiment)

```bash
# run on any machine with docker:
docker run --rm -v "$PWD:/w" python:3.11-slim \
  bash -c "pip install -q langchain-voyageai && python /w/repro.py"
```

```python
# repro.py — measures retention per fresh-client embed (API key is fake on
# purpose: the tokenizer is loaded and pinned BEFORE the HTTP call, so the
# 401 doesn't matter)
import gc

def rss_mb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024

from langchain_voyageai import VoyageAIEmbeddings

base = rss_mb()
for i in range(1, 121):
    enc = VoyageAIEmbeddings(model="voyage-3.5", api_key="pa-fake-0123456789")
    try:
        enc.embed_query("a")
    except Exception:
        pass
    if i % 30 == 0:
        gc.collect()
        print(f"iter {i}: +{rss_mb() - base:.0f} MB")
```

Observed: `+955 MB @30, +1859 @60, +2770 @90, +3670 @120` — **~31 MB per call, linear**. Reusing one cached instance instead: +55 MB once, then flat.

### D. Key evidence lines

- Kernel, 2026-10-29 03:45:24 UTC:
  `Out of memory: Killed process 635 (python) total-vm:2753012kB, anon-rss:1888284kB, file-rss:64kB`
- Proxy, same second:
  `Generation 22ebf60a-… failed mid-stream (transport_error): Connection to the retrieval server was lost mid-response.` (and identically for `f443e522-…`)
- Retrieval-server boot fingerprint (minutes after every restart, incl. 03:48):
  `Warning: You are sending unauthenticated requests to the HF Hub…`
- `retrieval-server/fly.production.toml` stopgap comment:
  `Bumped 1024mb -> 2048mb 2026-10-25: process RSS was climbing to the 1 GB ceiling and getting OOM-killed every ~3.5h (root cause still open).`
