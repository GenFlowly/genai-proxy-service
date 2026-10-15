# Harness evals

Behavioral pins for the agent harness (`tasks.yaml`), run against a **live
server with live vendor keys** — deliberately not part of the unit-test suite.
Run them on every harness-prompt or kernel change; "state of the art" means
this suite passing on your workloads, not resemblance to anyone's reference
implementation.

## One-time setup

1. A test customer with a seeded knowledge base. The `kb-multi-hop` task
   expects notes covering a refund policy for digital purchases and one for
   physical goods (any content with distinct time limits works).
2. The agent-loop graph published and its graphId at hand (admin panel →
   Default Agents → Publish Agent Loop, or a customer-owned copy).
3. For `compaction-survival` / `budget-exhaustion`: publish variant copies of
   the agent graph with the task's `config_overrides` applied to the generator
   node config, and export `EVAL_GRAPH_ID_COMPACTION_SURVIVAL` /
   `EVAL_GRAPH_ID_BUDGET_EXHAUSTION` with their graphIds. (Per-request config
   overrides are not a server feature — variants keep the server honest.)

4. For `pdf-revise` and `pdf-long`: the graph's TOOL_EXECUTOR must bind
   `generate_pdf` (which brings `revise_pdf` and `read_pdf_source`), and for
   `pdf-long` also `fs_write`/`fs_read` (the agent-loop template has them).
   `pdf-revise` runs its `setup_turns` first and replays the generated PDF
   as a file reference on the assistant turn, as the proxy does.

## Running

```bash
EVAL_BASE_URL=http://localhost:8000 \
EVAL_CUSTOMER_ID=CU… \
EVAL_GRAPH_ID=GRP… \
EVAL_PROVIDER=openai EVAL_MODEL=gpt-5 \
EVAL_CREDENTIALS_JSON='{"openai_api_key":"sk-…"}' \
.venv/bin/python evals/run_evals.py
```

`--only <task>` runs one task; `--update-baseline` rewrites
`evals/baseline.json` from the run. The exit code is 1 only when a task that
passed in the baseline now fails (regression) or on infrastructure failure —
a never-baselined task failing is a warning, so you can land the suite before
every task passes.

Model behavior is stochastic: a single flip on one run is a signal to
investigate, not necessarily a regression — rerun the task (`--only`) before
concluding. Keep `baseline.json` in the repo so the diff history tells the
story of the harness.
