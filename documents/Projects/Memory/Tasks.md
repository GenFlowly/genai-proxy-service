# Tasks: Memory page

The Memory page stops being a notes editor and becomes the place to see and manage what the assistant has learned: Profile memories (Core and Episodic) and each project's memories, with immutable versions, a change log that says what caused every change, and a usage log with a hit counter.

The agreed design is on the canvas: https://claude.ai/artifact/Qc9etJQdCicDPneeW1SNXr

`[x]` built and exercised, with evidence in `Acceptance Testing.md` · `[~]` built and unit-tested, not exercised end to end yet · `[ ]` not done · `[!]` blocked

Nothing is committed or pushed until the user says so. Bugs go in `Bugs.md`.

Status 2026-11-06: built and unit-tested on all four sides (proxy, retrieval server, web, iOS). Acceptance run on rebuilt local containers: desktop and mobile web mostly done, iOS Profile flows done. It found MEM-005 to MEM-016; the ones from this work are fixed on web, and the iOS ones wait for your go-ahead. See Open questions.

## Decisions

"User" rows are the user's calls. "Mine" rows are defaults I picked to keep going; each can be overruled.

| Topic | Decision | Whose |
|---|---|---|
| Notes on the frontend | Web and iOS stop saving, listing, searching and embedding notes. The notes backend APIs stay as they are. | User, 2026-11-05 |
| What the page shows | Profile memories (Core, Episodic) and Projects (same list as Chat). Sidebar rows open a list, they don't expand. | User, 2026-11-05 |
| Where memories apply | A profile memory applies in every conversation. A project memory applies only inside its project. A conversation in a project creates memories for that project. | User, 2026-11-05 |
| Core and Episodic in projects | Project memories keep both kinds. | User, 2026-11-06 |
| Adding a memory by hand | Yes: Add memory on desktop and mobile. | User, 2026-11-06 |
| Sorting | No sort chips. Lists are newest first. | User, 2026-11-06 |
| Versions and change log | Immutable. Every text change is a new version. Each change says what caused it: the conversation, the message, what was said and why. | User, 2026-11-06 |
| Move | Changes where a memory applies: Profile Core ↔ Episodic, Profile ↔ project, project → project. Versions and change log stay as they are. | User, 2026-11-06 |
| Copy | Project → project only. Adds a reference to the same memory, so both projects share its text, versions, change log and hit counter. | User, 2026-11-06 |
| Profile or projects, not both | A memory is in Profile or in one or more projects. Moving it to Profile drops its project references. | Mine, follows from the copy rule |
| Kind per project | The same memory can be Core in one project and Episodic in another. | Mine |
| Deleting a shared memory | In a project view of a memory that is in several projects: "Remove from this project" or "Delete everywhere". Removing the last reference deletes the memory. | Mine |
| Deleting a project | Its memories lose that project. Any memory left in no project is deleted. | Mine |
| What counts as a hit | Each reply a memory was sent to the model for: injected as Core, recalled as Episodic, or returned by the model's memory search. One usage-log row per reply (conversation id, message id). | Mine |
| "You said" in the change log | Read live from the message, so deleting the conversation also removes it from the log. Only the user's own messages are quoted. The log keeps the ids and the reason. | Mine, for privacy |
| Memories that exist today | Shown with one version and "History before <date> wasn't recorded". No backfill. | Mine |
| Settings that only made sense with notes | "Learn from notes" and the Notes embedding-model default are hidden on web and iOS. The stored preferences are untouched. | Mine |
| How fast edits reach chat | Within 60 seconds (the retrieval server's memory cache). Unchanged from today. | Mine |
| Assistant deletes from chat | When extraction decides to forget a memory, it is deleted as today, with a log line. | Mine |

## Phase 1: Backend (proxy server)

- [~] B1. Data model on the `MEM#` rows: `placements` (map of `PROFILE` or project id → `CORE`/`EPISODIC`), `version`, `hitCount`, `lastUsedAt`. Rows without `placements` read as `{PROFILE: kind}`, version 1. The API model keeps `kind` for older clients.
- [~] B2. Change log rows `MEMCHG#<id>#<time>` in `CustomerMemory`, written once and never updated. Types: learned, updated from a conversation or note, added by you, edited by you, moved, copied, removed from a project. Text changes carry the version, the new text and the previous text.
- [~] B3. Usage log rows `MEMUSE#<id>#<time>#<messageId>`; repository read, newest first, paged. Written by the retrieval server (R3).
- [~] B4. Service: create, edit (new version; 409 when someone else saved first), move, copy, remove from a project, delete everywhere (with its change and usage rows and its vectors), detail (versions and change log, with the conversation title and message excerpt read live), usage page.
- [~] B5. Routes: `POST /memories`, `GET /memories/{id}`, `PUT /memories/{id}`, `POST /memories/{id}/move`, `POST /memories/{id}/copy`, `DELETE /memories/{id}?projectId=`, `GET /memories/{id}/usage`; `GET /memories` returns the new fields. Web-app only (Auth0 JWT), like the existing memory routes. OpenAPI descriptions.
- [~] B6. Extraction: find the conversation's project (owner only). Show the extractor only Profile and this project's memories. ADDs from a project conversation go to that project. Number the transcript lines. The schema gains `reason` and `messageIndex`. Every ADD and UPDATE writes a change row with the conversation, message id and reason. UPDATE keeps where the memory applies. Note extraction writes change rows that point at the note.
- [~] B7. Prompt: `memory-extraction.system.txt` explains `reason`, `messageIndex` and project scope. The seeder never updates existing agents, so the live agent needs re-publishing (Release, step 3).
- [~] B8. Generation sends `project_id` (the conversation's project when the requester owns it), `conversation_id` and `response_message_id` to the retrieval server on the batch, streaming and durable paths. The batch path creates its response id before the call.
- [~] B9. Deletion: "Delete all learned facts" also removes change and usage rows. Deleting a project updates its memories as decided above. Account deletion already wipes the whole `CustomerMemory` partition; conversation deletion now also removes that conversation's usage rows (the memories and their change logs stay, as before). Tests added.
- [~] B10. Tests: repository (mocked DynamoDB client), service, routes (`testApplication`), extraction (update the positional stubs), orchestrator stubs. Full proxy suite: 566 passed, 0 failed.
- [~] B11. New metrics in the `development.md` metrics table.

## Phase 2: Retrieval server

- [~] R1. `project_id`, `conversation_id` and `response_message_id` on the retrieve and run requests and in graph state.
- [~] R2. Memory node: Core and recall use Profile memories plus the conversation's project only, each with its kind there. Old rows count as Profile. Over-fetch more, since other projects' hits are dropped after the search.
- [x] R3. Usage logging after the node picks its memories: one idempotent usage row per memory and reply, plus `hitCount` +1, in one transaction, off the event loop. Skipped when the ids are missing (internal requests, voice, evals). Failure metric. Acceptance found it never wrote anything (MEM-008); fixed, with a wire-format test, and verified live.
- [~] R4. `search_memories` tool: same scoping and usage logging. Fixes MEM-002, since the tool is being changed anyway.
- [~] R5. Tests with unittest: scoping, old rows, usage idempotency, the tool (`tests/test_memory_scope.py`). Full suite: 701 run, 1 error in `test_image_normalize` that reads Linux's `/proc` and can't run on macOS (file untouched; CI runs Linux).

## Phase 3: Web app

- [~] W1. Remove the notes UI and every notes call: `saveNotesService`, `NotesContext`, `useAutosave`, `NotesWidget`, `SavedNotesWidget`, `NotesHeader`, `NotesMenuContent`, `notesCache`, `encoding.models`, their registry and page-config entries, the logout cache clear, storage keys, i18n keys and tests.
- [~] W2. `memoriesService` and endpoints (ids URL-encoded), a react-query hook with a stale-while-revalidate cache; mutations update the cache in the service. Chat's learned-fact delete uses the encoded endpoint (MEM-001).
- [~] W3. Routes `/memory?scope=`, `/memory/new`, `/memory/:memoryId`; page titles; navbar and L1 menu flags.
- [~] W4. Desktop list: Profile and Projects sidebar cards with counts; header with title, subtitle and Add memory; 12-column grid of cards; card menu with Edit, Move to…, Copy to project… (project memories only) and Delete; empty states.
- [~] W5. Detail: breadcrumb band with Move to… and, for project memories, Copy to project…; versions sidebar; editor; Save as version N+1; Delete (with Remove from this project when shared); Change log and Usage log tabs (usage paged).
- [~] W6. New memory: Applies in, Kind, text.
- [~] W7. Move and copy dialog.
- [~] W8. Mobile: L2 Menu (Profile and Projects cards, Add memory pill, search over memories), list, actions sheet, detail, new memory.
- [~] W9. Settings: hide "Learn from notes" and the Notes embedding-model default.
- [~] W10. Tests, coverage gate, `CI=true npm run build`. Full suite 1048 passed; coverage of changed code 95% lines (gate 80%); strict build passes.

## Phase 4: iOS

- [~] I1. Remove the notes UI and calls from the Memory page and the menu; logout wipe.
- [~] I2. `MemoriesService`, models, endpoints (ids encoded), `MemoriesStore` with cache. Chat's learned-fact delete uses the encoded endpoint (MEM-001).
- [~] I3. Routes for the list scope, detail and new memory; the exhaustive route switches; `openPageMenu`.
- [~] I4. List, L2 Menu, actions sheet, move and copy, detail, new memory; strings from the web keys.
- [~] I5. Settings: the Notes embedding-model row is hidden (iOS never had the memory switches).
- [~] I6. Unit tests (185 passed, including the new Memories suite); builds clean for the simulator with the local stage. Not yet run on the simulator against a backend with this work.

## Phase 5: Acceptance

- [~] A1. Every row of `Acceptance Testing.md` on desktop web, mobile web and iOS, with screenshots. Done: almost every desktop row, the main mobile flows, and the iOS Profile flows. Not possible here: Episodic recall, memory search and L2 Menu search (the dev account has no vector DB, MEM-007); project flows on iOS (that account has no projects); Delete all learned facts (would wipe real memories).

## Release (only when the user says so)

1. Commit with explicit paths on `development`; PR to `main`.
2. Deploy: retrieval server and proxy (CI deploys both when `retrieval-server/**` changes). The retrieval server must be live before the proxy writes project memories, or another project's memory could be injected in the meantime. No CDK change: the new rows live in `CustomerMemory`.
3. Re-publish the MEMORY_EXTRACTION agent's prompt on dev and prod.
4. iOS build.

## Open questions

1. **iOS fixes (MEM-005, 013, 014, 015, 016):** go ahead?
2. **Publish the library fix for MEM-009?** Commit `Request.tsx` and its test to component-library `main`, which publishes it. Then bump the web app to that version (the admin panel uses the same composer and would get it on its next bump).
3. **Counters on two real memories:** two of the dev test account's own Core memories say "Used 12×" with no usage rows. The 12 came from my test chats before the MEM-010 fix. Reset both to 0?

## Answered

1. How to run acceptance (A1): rebuild the local containers (user, 2026-11-06). The user deleted the old images, and both containers were rebuilt fresh from this working tree. The compose file sits in the session scratchpad, not the repo, because the old `docker-compose.yml` was removed for holding a committed AWS key. Secrets come from `genai-proxy-server/.env` as before. Acceptance writes to the dev account: I only change memories and projects I create, prefixed "[acceptance]", and delete them afterwards.
2. **MEM-010** (user, 2026-11-06): "fine with this". Deleting a conversation takes its uses off the hit counter. Done.
3. **"Converation Agent" has no Memory node** (user, 2026-11-06): "thats a deprecated agent, ignore it".
4. **MEM-007** (user, 2026-11-06): not an issue, because production uses voyage-4-large. **MEM-009:** "fix this, it should not read draft from localstorage". Fixed in the library, not yet published.
