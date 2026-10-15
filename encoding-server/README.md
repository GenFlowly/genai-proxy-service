# Encoding Server

Serverless embedding pipeline (Python + AWS Lambda). Takes customer content
(notes, emails), chunks it, creates vector embeddings, and stores them in
per-customer Zilliz/Milvus collections for retrieval.

Deployed via CDK from the sibling `encoding-server-cdk` package.

## Core concepts

### Collections

One collection per **customer × data type × embedding model**:

```
{customerId}_notes_{modelName}     e.g. CU20EA760EBA18_notes_voyage_4_large
{customerId}_email_{modelName}     e.g. CU20EA760EBA18_email_voyage_4_large
```

Collections are created only by the `/create-collections` endpoint (called by
genai-proxy-server on every login/onboard, fire-and-forget). The embedding
model determines the vector dimension baked into the collection schema, and the
model metadata is stored as JSON in the collection description so the
retrieval-server can pick the matching query encoder. Content is **never**
allowed to create collections implicitly — inserts into a missing collection
fail.

### Embedding models

Resolved per request via `encoding_library.utils.model_registry`:

| model_type             | example model_name | dim  | runs                  |
|------------------------|--------------------|------|-----------------------|
| `sentence-transformer` | `all-MiniLM-L6-v2` | 384  | locally in the lambda |
| `openai`               | `text-embedding-3-small` | 1536 | OpenAI API (needs `OPENAI_API_KEY`) |
| `voyage`               | `voyage-4-large`   | 1024 | Voyage API (needs `VOYAGE_API_KEY`) |

The registry default is `sentence-transformer / all-MiniLM-L6-v2`, but the
platform standard is **voyage / voyage-4-large** — clients (genai-proxy-server,
EmailSyncMacApp) send it explicitly on every call. The model in an encode
request must match the model the customer's collection was created with.

## The two processing modes

### Realtime mode (default)

Content is embedded within seconds of the API call, one pipeline execution per
document:

```
API Gateway (JWT auth)
  POST /encode-notes ─▶ ingest_notes_lambda ─┐
  POST /encode-email ─▶ ingest_email_lambda ─┤
                                             ▼
                                        SQS queue
                                             ▼
                                     trigger_lambda
                                             ▼
                            Step Function (state-machine-v2)
                          parse_and_chunk ─▶ Map (concurrency 3):
                                              create_embeddings ─▶ store_embeddings
                                                                        ▼
                                                                  Zilliz/Milvus
```

- `parse_and_chunk` chunks the text and fans out batches of chunks.
- `create_embeddings` embeds synchronously (local model or provider API).
- `store_embeddings` writes vectors (`id = {noteKey}_{chunkIndex}`, so
  re-encodes overwrite instead of duplicating) and, for notes, marks the note
  synced in the `CustomerNotes` DynamoDB table.

Use realtime when content must be searchable immediately. Cost profile: the
full lambda/Step Functions machinery runs **per document**.

### Batch mode (Voyage only, notes only, customer-level)

Batch mode is **not a request parameter** — there is deliberately no
`processingMode` field on the encode APIs, and the ingestion pipeline has no
batch branch. Per-request batch jobs would cost the full realtime compute plus
batch bookkeeping while embedding a single document; the option was removed so
nobody reaches for it by mistake.

Instead, batch mode is enabled **per customer** by setting
`embeddingMode: "batch"` (and optionally `embeddingModel`) in the customer's
AIConfigPreferences via the genai-proxy-server preferences API / admin panel.
Once set, note saves never hit `/encode-notes` at all:

```
genai-proxy-server (note save)
  └─ flags note in CustomerNotes: embedding_status = "pending"  (sparse GSI)

every 30 min: accumulate_voyage_notes_lambda
  └─ sweeps ALL pending notes (≤ 2000/run), chunks in-process,
     uploads one JSONL to S3 (_staging/), creates ONE Voyage Batch API job,
     records a row in the VoyageBatchJobs table (status = pending)

every 10 min: poll_voyage_batches_lambda
  └─ reconciles in-flight jobs; on completion downloads results and stores
     them via the same store_embeddings logic, marks notes synced,
     resets failed notes back to pending
```

Why it's cheaper: a note save costs one DynamoDB update; the background sweep
cost is flat regardless of volume (50 notes or 2,000 notes = one Voyage job),
and the Voyage Batch API prices tokens at ~50% of the synchronous rate. The
trade-off is latency — a note becomes searchable minutes-to-hours after
saving (sweep interval + Voyage batch turnaround + poll interval).

Emails currently have no batch path; they are realtime-only.

## API

All routes sit behind API Gateway with Auth0 JWT auth. `AuthorizationService`
resolves the caller's `sub` claim to a `customerId` via the `CustomerProfile`
table — unknown users get 403.

### POST /create-collections

Creates the customer's collections for the given model (skips existing ones).

```json
{ "modelType": "voyage", "modelName": "voyage-4-large" }
```

Omitting the model falls back to the registry default (MiniLM, 384-dim) — 
always pass it explicitly.

### POST /purge-vectors

Deletes a customer's vectors when genai-proxy-server purges the customer or
one of their conversations (PDF plan 3.9). Service-to-service only: the proxy
sends an Auth0 client-credentials (machine-to-machine) token, which the API
Gateway JWT authorizer validates like any other; the handler then requires
`gty = client-credentials` and the token's client id (`azp`) in
`PURGE_ALLOWED_CLIENT_IDS`. User tokens get 403, and so does every call while
`PURGE_ALLOWED_CLIENT_IDS` is unset.

```json
{ "customerId": "CU20EA760EBA18", "conversationId": "<conversation id>" }
```
deletes every vector with `conversation_key == "<conversation id>"` from the
customer's `{customerId}_conversation_*` collections, and

```json
{ "customerId": "CU20EA760EBA18", "dropCollections": true }
```
drops every `{customerId}_*` collection. Both are idempotent (a missing
collection or vector is not an error). Ids are validated first: customer ids
are `[A-Za-z0-9-]` only (so the `{customerId}_` prefix never matches another
customer), conversation ids too (so they cannot break out of the filter), and
`System`/`PUBLIC` are refused.

### POST /encode-notes and POST /encode-email

Accept a single envelope or an array of envelopes. snake_case key variants are
also accepted.

```json
{
  "client": "REACT_APP",
  "modelType": "voyage",
  "modelName": "voyage-4-large",
  "chunkSize": 1500,
  "chunkOverlap": 150,
  "data": {
    "note_key": "abc123",
    "note_value": "note text ...",
    "title": "My note",
    "created_at": "2026-08-23T00:00:00Z"
  }
}
```

`chunkSize` / `chunkOverlap` (tokens) are optional per-request chunking
overrides for experimentation. Resolution order: request override →
per-model row in the **EmbeddingModelRegistry** DynamoDB table
(PK `modelType`, SK `modelName`; seed with
`python scripts/seed_model_registry.py`, tune rows without a code deploy;
values cache per lambda process) → code defaults (1000/200).

Email `data` requires: `message_id`, `subject`, `body`, `from`, `to`, `date`,
`folder`. Responses are 202-style: items are validated and queued; embedding
happens asynchronously.

## Repository layout

```
handlers/
  ingest_notes_lambda.py           # /encode-notes → SQS
  ingest_email_lambda.py           # /encode-email → SQS
  create_collections_lambda.py     # /create-collections
  purge_vectors_lambda.py          # /purge-vectors (customer / conversation purge)
  trigger_lambda.py                # SQS → starts Step Function
  parse_and_chunk_lambda.py        # chunking step
  create_embeddings_lambda.py      # realtime embedding step
  store_embeddings_lambda.py       # Milvus insert + CustomerNotes sync
  accumulate_voyage_notes_lambda.py# batch mode: 30-min sweep → one Voyage job
  poll_voyage_batches_lambda.py    # batch mode: 10-min reconcile + store
  voyage_batch_store.py            # shared: map batch results → store logic
services/
  authorization_service.py         # JWT sub → customerId
tests/                             # unittest suite (see Local development)
Dockerfile.*                       # one image per pipeline step (see below)
```

Shared chunking/embedding/model logic lives in the sibling `encoding-library`
package (`encoding_library.utils.embedding_utils`, `model_registry`,
`voyage_batch`, `processors/*`).

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt              # plus per-image requirements as needed
pip install -e ../encoding-library
```

Handlers can be invoked directly with a synthesized API Gateway v2 event:

```python
import json
from handlers.ingest_notes_lambda import handler

event = {
    "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "<auth0 sub>"}}}},
    "body": json.dumps({
        "client": "LOCAL_DEV",
        "modelType": "voyage",
        "modelName": "voyage-4-large",
        "data": {
            "note_key": "test-1",
            "note_value": "hello world",
            "title": "test",
            "created_at": "2026-08-23T00:00:00Z",
        },
    }),
}
print(handler(event, None))
```

Requires AWS credentials (DynamoDB for auth) and `QUEUE_URL` pointing at a
queue you can write to.

Tests need no AWS access or network (the vector store is faked). From this
directory, with a venv that has the requirements and `encoding-library`
installed (the retrieval-server venv works too):

```bash
python -m unittest discover -s tests -t .
```

## Build and deploy

Each pipeline step is a Docker image (separate ECR repos, built from the
matching `Dockerfile.*`):

| Image | Dockerfile | Backs |
|---|---|---|
| milvus-base | `Dockerfile.milvus_base` | base layer (pymilvus etc.) |
| ingestion | `Dockerfile.ingestion` | ingest notes/email lambdas |
| parse-and-chunk | `Dockerfile.parse_and_chunk` | parse_and_chunk, trigger lambda |
| create-embeddings | `Dockerfile.create_embeddings` | realtime embed step |
| store-embeddings | `Dockerfile.store_embeddings` | store step + batch accumulator + poller |
| create-collections | `Dockerfile.create_collections` | /create-collections, /purge-vectors (CMD override) |

Infrastructure (lambdas, SQS, Step Function, API Gateway, EventBridge
schedules, `VoyageBatchJobs` table) is defined in `../encoding-server-cdk`:

```bash
cd ../encoding-server-cdk
npm install
VOYAGE_API_KEY=... npx cdk deploy --all   # key is baked into lambda env at deploy time
```

`VOYAGE_API_KEY` must be present in the deploy environment for any voyage
embedding (realtime `create_embeddings`, batch accumulator/poller). Batch-mode
schedules (30-min accumulate, 10-min poll) are EventBridge rules in
`lambda-stack.ts` if you need to tune cadence.

## Key environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `QUEUE_URL` | ingest lambdas | SQS ingestion queue |
| `STATE_MACHINE_ARN` | trigger lambda | Step Function to start |
| `ZILLIZ_ENDPOINT` / `ZILLIZ_TOKEN` | store, poller, create-collections | global Zilliz cluster (per-customer override via `CustomerVectorDBConfig` + KMS) |
| `CUSTOMER_PROFILE_TABLE_NAME` | auth | JWT sub → customerId |
| `CUSTOMER_NOTES_TABLE` | store, accumulator, poller | note sync flags / batch queue |
| `NOTES_EMBEDDING_STATUS_INDEX` | accumulator | sparse GSI of pending notes |
| `EMBEDDING_MODEL_REGISTRY_TABLE` | parse_and_chunk, accumulator | per-model chunking params table |
| `VOYAGE_BATCH_TABLE` | accumulator, poller | in-flight Voyage job tracking |
| `DOCUMENTS_BUCKET` / `STAGING_PREFIX` | accumulator, poller | batch payload staging + per-note documents |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | embed lambdas | hosted embedding providers |
| `MAX_NOTES_PER_RUN` | accumulator | notes per sweep (default 2000) |
| `PURGE_ALLOWED_CLIENT_IDS` | purge-vectors | comma-separated Auth0 client ids allowed to purge (unset = refuse all) |
