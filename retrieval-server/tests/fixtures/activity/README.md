# Activity log fixtures

Golden activity logs, one per scripted turn in `tests/activity_scenarios.py`. The retrieval server's recorder tests write and check them; the component library (`ActivityPanel/fixtures/`) and the iOS app (`AI WrapperTests/ActivityFixtures/`) keep byte-identical copies and test their reducers against them. Regenerate only after a deliberate contract change:

```
REGENERATE_ACTIVITY_FIXTURES=1 .venv/bin/python -m unittest tests.test_activity_recorder
```

File shape: `{name, description, live, stop_reason, events: [activity events], web_sources: [final cited sources]}`. `live` true means the turn is still streaming; `stop_reason` "cancelled" means the user stopped it.

| file | what it covers |
|---|---|
| `completed_six_searches.json` | design 6 done boards: memory, two search rounds of three, the answer; 22 s, 31 sources, 6 cited |
| `live_mid_turn.json` | design 6 live board: the same turn at 14.3 s, second round running with one call finished |
| `denied_searches.json` | soft budget 3 and hard cap 5: `run`, `note`, `skip` and `exhausted` calls across three rounds |
| `error_turn.json` | one failing call, then the next model round fails; `turn.end` outcome `error` with an open llm step |
| `subagent_call.json` | a `spawn_agent` call with `details`; the child graph's own events never become steps |
| `memory_only.json` | no tools: memory, then the answer |
| `stopped_turn.json` | stopped during the first search round; no `turn.end`, an open tools step with two of three calls finished |

## Where each design 6 element comes from

"Client" means the reducer derives it; everything else is a field in the log.

| element | source |
|---|---|
| Time tile | `turn.end.duration_ms`; live: client clock from `turn.start` |
| Searches tile "used of max" | client: count of `web_search` calls issued (llm `tool_calls`); max from the latest tools `step.end.budget.max` |
| Sources tile "found → cited" | client: sum of `calls[].sources` across tools steps → `turn.end.cited` (falls back to the `web_sources` indices for logs without it) |
| Memories tile | memory `step.end.counts.core + counts.recalled` |
| Phase bar and legend | client: memory steps → Memory; llm `tool_calls` steps before any tools step → Plan; tools steps → Search (Tools when not all calls are web searches); later llm time and the final llm step up to `first_token_ms` → Reason; the final step after `first_token_ms` → Answer |
| Header "Thinking · 14s · …" / "Thought for 22s · …" | client, from the tiles above |
| Panel open while thinking, folded once the answer streams | client: the newest step is an llm step with `step.writing` and no `step.calling`, or the answer step that just ended; a preamble ("Let me look that up…") is followed by `step.calling` and never reaches `step.writing` |
| Beat title | client wording from the step: memory `counts`; llm `outcome` and `tool_calls`; tools `calls` names and count |
| Beat quote | llm `step.end.reasoning`; per call `args.purpose` |
| Beat duration | `step.end.duration_ms` (an llm beat that called tools adds its tools step) |
| Running queries and their ticks | llm `tool_calls[].args.query`; ticks and counts from `step.call` events |
| Per-query count and time | `calls[].result_count`, `calls[].duration_ms` (live: `step.call.call`) |
| Result preview rows | `calls[].sources[]`: `favicon`, domain (client, from `url`), `title`, `published_date` |
| "cited [n]" badge | client: `sources[].index` found in `turn.end.cited` |
| "Wrote the answer from N sources" | final llm `step.end` with `outcome` answer; N = cited count |
| Evidence groups | one per tools step, header from the step; rows from its `calls[].sources` |
| Cited / Not cited / Failed filters | client: cited = in `turn.end.cited`; not cited = the rest; failed = calls with `error` or mode `skip` / `exhausted` |
| Skipped or denied call note | `calls[].mode`, `calls[].result_excerpt` |
| Memory expander | memory `step.end.memories` (author only; stripped by the proxy for other viewers) |
| Developer expander | llm `step.end.developer` (author only; stripped by the proxy for other viewers) |
| Interrupted / failed beat | client: an open step when the turn is not live (`stop_reason` cancelled) or `turn.end.outcome` is `error` |
