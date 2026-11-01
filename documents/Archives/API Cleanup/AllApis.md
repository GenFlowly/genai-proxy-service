# All Frontend APIs — Inventory, Caching State, and Target Policy

As of 2026-10-31. Built from the canonical `src/config/endpoints.ts` registry plus a raw grep for every `fetch`/`fetchWithRetry`/`EventSource`/`sendBeacon` call, cross-checked against every exported function in all 31 service files. ~77 distinct endpoint+method calls. Companion doc: `LoginApiCallsAndCaching.md` (login-burst deep dive).

**Standing rules (decided 2026-10-31):**
1. **One caching strategy** — react-query is the data layer; mutations update the cache AND fire the API together, with the cache write/invalidation living **inside the service function** (`agentsService.ts` is the approved model), never per-caller.
2. **NEVER cache credentials or credential-adjacent data** — vendor API keys, key statuses, Zilliz/vector-DB config, Tavily/tool credentials, embedding keys. Not in localStorage, period.
3. Conversation content stays uncached (decided — see LoginApiCallsAndCaching.md Decisions).

Legend for "Target": **OK** = current state matches the decided policy, no change · **TASK n** = change required, see Tasks section.

| Domain | Endpoint | What it does | When called | Current caching | Target |
|---|---|---|---|---|---|
| Auth/profile | `POST /onboard` | Login sync: customerId, prefs, vendor-key statuses, instructions, vectorDB statuses, cacheVersions counters | Every authenticated mount | None at HTTP layer; sub-fields mirrored to localStorage (`${cid}_ai_preferences`, `${cid}_instructions`, `${cid}_vendor_api_key_statuses`) | **TASK 3** — stop persisting `${cid}_vendor_api_key_statuses` (credential-adjacent); rest OK |
| Auth/profile | `GET /profile` | Username + discoverability | ProfileSettings / ProfileSettingsWidget mount — each does its own uncached fetch | None | **TASK 2** — cache (SWR per customer), shared by both consumers |
| Auth/profile | `POST /profile/username`, `POST /profile/discoverability`, `POST /profile/onboarding-completed` | Profile mutations | User action | No cache updated (none exists yet) | **TASK 2** — write-through the new profile cache in-service |
| Auth/profile | `GET /users/search?username=` | Find users to share with | ShareModal typing | None (correct — live search) | **OK** — and DDB lookup is already indexed: `UsernameLookup` PK=`username` + `recordTypeIndex` GSI queried with `begins_with`, limit 5 (`CustomerProfileRepository.kt:258`) |
| Auth/profile | `GET /customer/profile` | **DEAD** — zero call sites (`endpoints.ts:8`) | never | — | **TASK 1** — delete registry entry |
| AI config | `GET /providers` | BYOK provider catalog | Login prefetch; consumed by `useVendorDisplayNames` → BrandName (AIVendorWidget, VendorModelSelect, history sidebar vendor badges, AISettings, EmbeddingKeysSettings, ConfigureAIVendorSettingsWidget) + StepLlmApiKey + AISettings | react-query `staleTime: Infinity` (once/session) + localStorage `provider_catalog_cache` placeholder | **OK** — platform-static, widely shared |
| AI config | `POST /models` | Text-gen model catalogs per valid-key vendor | AIVendorWidget / VendorModelSelect / AISettings via one shared query keyed on the vendor set | react-query staleTime 0 (refetch on mount) + localStorage `${cid}_ai_vendor_models` seed | **TASK 4** — convert to `GET /models?vendors=` (it's a read; backend route is `post()` today); caching itself OK |
| AI config | `POST /save-ai-config` | Save preferred model/agent/embedding defaults | 4 call sites | **BROKEN write-through** — 0 of 4 callers update the `aiConfigPreferences` mirror; AIContext seed guard then pins the stale paint | **TASK 5** — in-service write-through (prefs store extraction) + seed-guard fix; already specced in LoginApiCallsAndCaching.md |
| AI config | `POST /store-api-key`, `POST /store-vendor-config` | Vendor LLM key save/validate | Settings / onboarding | Status write-through correct, but statuses land in localStorage `${cid}_vendor_api_key_statuses` | **TASK 3** — statuses stay in React state only; never persisted. (Note: key *material* was never cached anywhere — this is the status mirror.) |
| AI config | `GET /embedding-keys` | Embedding key statuses | EmbeddingKeysSettings / StepVoyageApiKey mount | None — page-local | **OK** (credential-adjacent: correctly uncached) |
| AI config | `POST /store-embedding-key`, `DELETE /embedding-keys/{vendor}` | Embedding key mutations | Settings / onboarding | Never cached (correct), but **no invalidation of `EMBEDDING_MODELS_QUERY_KEY`** — stale probed catalog until next Settings remount | **TASK 6** — in-service invalidation |
| AI config | `GET /embedding-models` | Probed embedding-model catalog | Settings → Defaults mount only | react-query `refetchOnMount:'always'` + localStorage envelope placeholder — cached AND revalidated on load | **OK** (the revalidate-on-load ask is already how it works); TASK 6 closes the mutation gap |
| AI config | `POST /store-vector-db-config` | Zilliz config | Settings / onboarding | React state only — no localStorage | **OK** (credential rule already honored) |
| Generation | `POST /generate-text-stream` | Main chat generation (NDJSON stream) | Send message | None | **OK** — streams are never cached |
| Generation | `POST /generate-text` | Non-stream fallback | ConversationContext fallback | None | **OK** |
| Generation | `POST /generations/cancel` | Stop a generation | Stop button | None | **OK** |
| Generation | `GET /runs/{id}/stream?fromSeq=` | Reattach to durable run after reload/backgrounding | Deep link / recovery | None | **OK** |
| Generation | `POST /runs/{id}/resume` | Human-in-the-loop reply to paused run (raw `fetch`, not fetchWithRetry — `resumeRunService.ts:15`) | User action | None | **OK** |
| Generation | `POST /batch-generate-text` | **DEAD** — zero call sites, no backend route found | never | — | **TASK 1** — delete registry entry |
| Generation | `POST /conversation/title` | Title generation | After first exchange | Patches historyCache via title-patch effect | **OK** |
| Agents | `GET /agents` | Customer agent list | Login via one shared `useCustomerAgents` query (old duplicate eliminated) | **Version-gated react-query** — zero network when the /onboard `cacheVersions.agents` counter is unchanged; localStorage envelope `${cid}_customer_agents_cache` | **OK** — stronger than plain SWR: the counter IS the revalidation signal, so an unchanged version skips the call entirely instead of revalidating blind. Keep. |
| Agents | `GET /agents/{graphId}` | Single agent detail | EditAgentPage / GraphAgentEditorPage mount | None — page-local fetch every mount | **TASK 7** — SWR cache per graphId: paint cached, revalidate on load, cache updates |
| Agents | `POST /agents/graph`, `PUT /agents/{id}`, `POST /agents/{id}/fork` | Agent mutations | Editor pages | In-service invalidation (`agentsService.ts:18-21`) → triggers a refetch | **TASK 8** — upgrade invalidate→`setQueryData` with the mutation response (local update, no refetch round trip), still in-service |
| Agents | `GET /request-agents` | requestType→agent mapping | Login via shared `useRequestAgents` query | Version-gated (counter `cacheVersions.requestAgents`), localStorage envelope | **OK** — same rationale as `GET /agents` |
| Agents | `PUT/DELETE /request-agents/{type}` | Mapping mutations | DefaultsSettings save | Per-caller invalidation of both query keys | **TASK 9** — mutation needs no cache of its own (agreed); move the invalidation into the service so a second caller can't forget it |
| Agents | `GET /node-presets` | Graph editor node presets | Editor mount | None | **OK** — editor-only, near-static, cheap |
| Conversations | `GET /conversations`, `GET /conversations/pinned`, `GET /projects` | Sidebar history / pinned / projects | History component mount | `customerListCache` blob `${cid}_conversation_history_cache_v1` — paints cached, always revalidates on load, single mirror effect persists every state change | **OK** — already exactly the decided policy (cache + revalidate-on-load + cache updates) |
| Conversations | pin/unpin/fork/archive/delete, assign/unassign project, `POST /project`, rename/delete project | History mutations | User actions | Optimistic state + mirror effect — local cache updates with the mutation | **OK** — correct by construction (single-writer component) |
| Conversations | `GET /chat?conversationId=` | Full conversation load (+ pendingRuns reattach) | Deep link / refresh only | None | **OK** — never cache (standing decision) |
| Conversations | `GET /conversation/unarchive` | **DEAD** — zero call sites | never | — | **TASK 1** — delete registry entry + dead export |
| Conversations | `POST/DELETE /conversation/share`, `GET /conversation/shared` | Share/unshare, shared-users list | Share modal | None — per-modal | **OK** |
| Instructions | `GET /instructions` | Full instruction list | `refreshInstructions` + agent editor pages | AuthContext mirror + localStorage `${cid}_instructions`, refreshed by /onboard — cache + revalidate | **OK** read-side; write-side gap is TASK 10 |
| Instructions | `GET /instructions/search?q=` | Semantic search | Picker typing | None (correct — live search) | **OK** |
| Instructions | `GET /instructions/recent` | Recently used instructions | Picker open | `${cid}_recent_instructions_cache_v1` SWR — paints cached, refetches on every open | **OK** — already the decided policy |
| Instructions | `POST /instruction`, `DELETE /instruction/{id}` | Create/delete | Detail page + EditAgentPage | INCONSISTENT — detail page updates the mirror, **EditAgentPage:523 does not** | **TASK 10** — move mirror update in-service |
| Instructions | share/unshare, `GET /instruction/shared` | Sharing | Detail page | None — per-modal | **OK** |
| Instructions | `GET /instruction/version` | **DEAD** — `getInstructionVersion` has zero call sites | never | — | **TASK 1** — delete |
| Notes/memory | `GET /notes` | Saved notes list | SavedNotesWidget mount | `${cid}_saved_notes_cache_v1` SWR + mirror effect | **OK** read-side |
| Notes/memory | `POST /notes` (incl. `keepalive` tab-close flush), `DELETE /notes` | Note mutations | Autosave / user action | PlainNotes publishes the update; **KeyValueNotes.tsx:29 does not** — sidebar never sees key-value saves this session | **TASK 11** — move `publishNoteUpdate` in-service |
| Notes/memory | `GET /conversation/learned-facts`, `DELETE /memories/{id}` | Memory facts | User opens facts UI | None | **OK** |
| Attachments | `POST /attachments` → presigned S3 `PUT` → `GET /attachments/url` | Upload presign, direct S3 upload, view URL | Attach / render | None | **OK** — presigned URLs are time-limited by design |
| Usage | `GET /message/usage`; `GET /usage/llm`, `/usage/embedding`, `/usage/vector-db`, `/usage/web-search` | Token/cost dashboards | Per response / usage pages | None | **OK** — live metrics |
| Tools/connectors | `GET /tools`, `GET /tools/{name}`, `POST/DELETE /tools`, `POST /tools/{name}/dry-run`; `GET/POST/DELETE /tool-credentials`; connectors CRUD + OpenAPI/MCP import; developer API-key CRUD | Tool & connector management | Settings pages | None — page-local, reload after mutation | **OK** — credentials correctly never persisted; page-local reload is acceptable for admin-frequency pages |

**Non-backend:** Auth0 SDK (token cache is the SDK's, localStorage-backed — cleared by the logout `localStorage.clear()`); service worker precaches static assets only.

## Validation notes on the directives

- **Username search**: no new index needed — `UsernameLookup` is already a dedicated lookup table (PK=`username`) and the prefix search runs on its `recordTypeIndex` GSI with `begins_with`, capped at 5 results. Fast path already exists.
- **`/providers` consumers**: yes — the AI Config widget (and every other surface showing a vendor name) reads it via `useVendorDisplayNames`; the session cache is shared app-wide through the one react-query key.
- **Vendor key "caching"**: only *statuses* (vendor + VALID/INVALID) were ever persisted, never key material. Removed anyway per the credential rule — statuses will live in React state only, repopulated by each /onboard.
- **`GET /agents` / `GET /request-agents`**: the current version-gated cache is deliberately kept instead of downgrading to always-revalidate — the /onboard counter is a true invalidation signal, so an unchanged version skips the network entirely (strictly better than SWR); a changed version refetches and updates the cache, which satisfies the revalidate requirement.
- **`GET /embedding-models`**, **conversations/pinned/projects trio**, **`GET /instructions/recent`**: already implement cache + revalidate-on-load + cache-update — no change needed.

## Tasks

- [ ] **TASK 1 — Delete dead API surface.** Registry entries `getCustomerProfile` (`endpoints.ts:8`), `batchGenerateText` (`endpoints.ts:24` — no backend route exists either), `unarchiveConversation` (`endpoints.ts:37`) + the dead `unarchiveConversation` export (`conversationHistoryService.ts:209`), and `getInstructionVersion` (`instructionService.ts:85`). Pure deletions, zero call sites for all four.

- [ ] **TASK 2 — Cache `GET /profile` + write-through on profile mutations.** One shared SWR cache (react-query key `['profile', cid]`, localStorage seed via `customerKey(cid, 'profile')`): paint cached, revalidate on mount. `updateUsername`/`updateDiscoverability`/`completeOnboarding` update it **in the service** on success (responses carry the new values). Both consumers (ProfileSettings, ProfileSettingsWidget) move onto the hook — today each fires its own uncached fetch.

- [ ] **TASK 3 — Never persist credential-adjacent data.** Remove the `${cid}_vendor_api_key_statuses` localStorage mirror (`AuthContext.tsx` readCache/writeCache sites): statuses live in React state only, seeded fresh by each /onboard. Consequence to accept: on reload the AI Config widget's vendor toggles are unknown until /onboard resolves (brief empty state instead of a stale paint). Codify the rule in `storageKeys.ts`'s doc comment: vendor keys, key statuses, Zilliz config, Tavily/tool credentials, embedding keys — never in localStorage.

- [ ] **TASK 4 — `POST /models` → `GET /models?vendors=a,b`.** It's a pure read; the body is just the vendor list. Backend: add the GET route (`GetTextGenerationModelsActivity.kt` — keep POST accepted during the transition, delete it one release later). Frontend: `getTextGenerationModels` switches to GET with a `vendors` query param; the shared `useTextGenerationModels` query is unchanged otherwise.

- [ ] **TASK 5 — Fix `saveAIConfigPreferences` write-through (the stale-preferred-model bug).** Already specced in `LoginApiCallsAndCaching.md` Tasks: extract the prefs mirror into a module-level store the service writes on success (all 4 call sites currently skip `updateAiConfigPreferences`), and fix the AIContext seed guard so fresh server prefs can overwrite a cache-seed (today its own stale seed registers as "an active selection" and blocks the re-sync).

- [ ] **TASK 6 — Embedding-key mutations invalidate the model catalog in-service.** `storeEmbeddingKey`/`deleteEmbeddingKey` call `queryClient.invalidateQueries({queryKey: [EMBEDDING_MODELS_QUERY_KEY]})` inside `embeddingKeysService.ts` (one-liner mirroring `agentsService`). Fixes: add a key → new vendor's models appear without leaving Settings; delete a key → phantom models disappear.

- [ ] **TASK 7 — Cache `GET /agents/{graphId}`.** `useAgent(graphId)` hook: SWR (paint last-known, revalidate on mount, save fresh), localStorage envelope keyed `customerKey(cid, 'agent_' + graphId)` or derived from the list cache where possible. Agent mutations (TASK 8) also `setQueryData` this key.

- [ ] **TASK 8 — Agent mutations update the cache locally instead of refetch-only.** `agentsService.ts` create/update/fork already invalidate in-service; upgrade to `queryClient.setQueryData` with the mutation's returned agent (merge into the list + per-graph entries) and refresh the localStorage envelope, so the UI reflects the write without a follow-up `/agents` round trip. Keep the version counter bump server-side as the cross-device signal.

- [ ] **TASK 9 — Move request-agent mapping invalidation in-service.** `putRequestAgentMapping`/`deleteRequestAgentMapping` invalidate `REQUEST_AGENTS_QUERY_KEY` (+ `CUSTOMER_AGENTS_QUERY_KEY`, since mapping retags agents server-side) inside `requestAgentsService.ts`; remove the caller-side invalidation from DefaultsSettings. No cache for the mutations themselves.

- [ ] **TASK 10 — Instruction mutations write through in-service.** `createInstruction`/`deleteInstruction` update the `customerInstructions` mirror + `${cid}_instructions` on success instead of relying on each caller (`EditAgentPage.tsx:523` "Convert to instruction" currently skips it — those instructions are invisible app-wide for the session). Requires the mirror to be service-writable (same module-store extraction pattern as TASK 5, or a `queryClient`-held instructions cache).

- [ ] **TASK 11 — Note saves publish in-service.** `saveNote`/`deleteNote` (`saveNotesService.ts`) call `publishNoteUpdate`/update `notesCache` themselves; removes the per-caller gap where `KeyValueNotes.tsx:29` skips it and key-value saves never appear in the Saved Notes sidebar.

Sequencing: TASK 1 and 6 are independent one-liners, ship first. TASK 5/10/11 share the "mirror becomes service-writable" pattern — do together. TASK 3 rides with TASK 5 (both touch AuthContext mirrors). TASK 4 needs a backend deploy before the frontend switch. TASK 7+8 go together.
