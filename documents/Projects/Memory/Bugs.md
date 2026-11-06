# Bugs: Memory page

Severity: High, Medium, Low. Status: Open, Fix planned, Fixed (in code, unit-tested, not yet run live), Fixed, Won't fix. Side: Web, iOS, Both, Backend.

| ID | Severity | Status | Side | Bug |
|---|---|---|---|---|
| [MEM-001](#mem-001) | High | Fixed (web verified live) | Both | Deleting a learned fact says it worked but the memory stays |
| [MEM-002](#mem-002) | Medium | Fixed (in code) | Backend | The model's memory search fails on every call |
| [MEM-003](#mem-003) | Low | Open | Backend | Every memory write forces a vector-store flush |
| [MEM-004](#mem-004) | Low | Open | Backend | An earlier reply's learning indicator can be left pending |
| [MEM-005](#mem-005) | Low | Fixed on web; iOS open | Both | A save conflict tells you to reload, but the page has already reloaded |
| [MEM-006](#mem-006) | Low | Fixed (verified live) | Web | The shared-memory delete dialog's three buttons wrap untidily |
| [MEM-007](#mem-007) | Medium | Won't fix (user, 2026-11-06) | Backend | Memories never get vectors when the conversations embedding model is multimodal |
| [MEM-008](#mem-008) | High | Fixed (verified live) | Backend | No use of a memory was ever recorded: no usage rows, hit counter stuck at 0 |
| [MEM-009](#mem-009) | Medium | Fixed in library (verified live), unpublished | Web | A new chat's sent first message comes back as the next new chat's draft |
| [MEM-010](#mem-010) | Medium | Fixed (verified live) | Both | After a conversation is deleted, "Used N×" stays but the usage log says "Not used in any reply yet" |
| [MEM-011](#mem-011) | Low | Fixed | Web | AI Settings still says the priority 1 provider writes "note titles" |
| [MEM-012](#mem-012) | Low | Fixed (verified live) | Web | Delete in the mobile actions sheet isn't red |
| [MEM-013](#mem-013) | Low | Fixed on web; iOS open | Both | A version you added by hand says "Edited by you" |
| [MEM-014](#mem-014) | Low | Open | iOS | Delete in the iOS actions sheet uses an archive icon |
| [MEM-015](#mem-015) | Low | Open | iOS | New memory: Save sits half under the keyboard, and there's no Cancel |
| [MEM-016](#mem-016) | Low | Open | iOS | Small differences from the web on the Memory screens |

## MEM-001

**Deleting a learned fact says it worked but the memory stays**

- **Steps:** in Chat, open the brain icon on a reply that learned something, press ✗ on a fact. Same on iOS.
- **Expected:** the memory is deleted.
- **Actual:** the fact disappears from the popover, but the memory is still stored and keeps being used in replies.
- **Cause (read from the code):** memory ids look like `MEM#<uuid>`. Web `endpoints.ts:89` and iOS `AppConfig.swift:144` put the id into the URL path without encoding, so `#` starts a URL fragment and the request goes to `/api/v1/memories/MEM`. The server answers 404, and both clients treat 404 as "already deleted".
- **Confirmed:** from the code, plus Node's URL parser showing the path sent is `/api/v1/memories/MEM` with `#3f2a-uuid` dropped as a fragment. Not run against the server.
- **Not caused by this work.**
- **Fix planned:** the new memories endpoints (W2, I2) encode ids, and chat's delete will use them, because the new Memory page shares the same call. Say if you want this handled separately.
- **Fixed in code, 2026-11-06:** web `endpoints.memory()` and iOS `MemoriesService.url()` percent-encode the id; chat's ✗ (`deleteMemoryFact`, `LearnedFactsService.delete`) now goes through them. A 404 still counts as "already deleted".
- **Tests:** web `learnedFactsService.test.ts` and `MemoryPage.test.tsx` assert the request path ends in `MEM%23…`; iOS `MemoryModelTests.idsKeepTheirHashInTheURL`; proxy `MemoryRoutesTest` checks a `%23` id reaches the service intact.
- **Verified live on web, 2026-11-06:** ✗ on "1 fact added to memory" under a reply deleted the memory: the API then answered 404 and the proxy logged "Deleted memory" and "Successfully deleted vectors". iOS not yet run.

## MEM-002

**The model's memory search fails on every call**

- **Steps:** in a chat with memory on, ask something that makes the model call `search_memories`.
- **Expected:** matching memories come back.
- **Actual:** the tool returns "Memory search failed…" every time and counts `memory_recall_failure_total{source=tool}`.
- **Cause (read from the code):** `retrieval-server/graph/memory_tool.py:197` calls `_embed_query(query, model_type, model_name)`, but `graph/nodes/memory.py:120` now takes `customer_id` first. The `TypeError` is caught at line 227. The tests replace `_embed_query` with a stub, so they miss it.
- **Confirmed:** from the code. Not run.
- **Not caused by this work.**
- **Fix planned:** R4, since the tool gets project scoping in this work anyway.
- **Fixed in code, 2026-11-06:** the tool passes the caller's `customer_id` first. `tests/test_memory_scope.py` patches `_embed_query` with `autospec=True`, so a wrong call now fails the test.
- **Not yet run against a live server:** the test account has no vector DB, so the model never called the tool during acceptance.

## MEM-003

**Every memory write forces a vector-store flush**

- **Where:** `retrieval-server/routes/notes.py:239`, `/encode-memory`.
- **Actual:** each memory encode calls `client.flush()`. The conversation path deliberately doesn't (`notes.py:356`: "the cluster allows ~1 flush per 20s in total").
- **Effect on this work:** adding and editing memories by hand re-encodes them, so flushes get more frequent. A flush over the quota would fail the encode, which then waits for the vector retry.
- **Confirmed:** from the code. Not run.
- **Not caused by this work.** Not fixed: waiting for your go-ahead.

## MEM-004

**An earlier reply's learning indicator can be left pending**

- **Steps:** a learning run fails with a retryable error after reply A, then reply B is sent in the same conversation before the retry.
- **Expected:** A settles as "nothing new" or shows what was learned.
- **Actual:** the pending row keeps only the latest reply id (`MemoryRepository.putPendingExtraction` overwrites `responseMessageId`). The retry settles B, so A's brain icon keeps polling until the client gives up.
- **Confirmed:** from the code. Not run.
- **Not caused by this work.** Not fixed: waiting for your go-ahead.

## MEM-005

**A save conflict tells you to reload, but the page has already reloaded**

- **Steps:** open a memory, change its text, and before saving let another device save a new version (done through the API), then press Save.
- **Expected:** a message that matches what the page now shows.
- **Actual:** the server correctly refuses with 409 and the draft is kept, but the toast says "This memory changed while you were editing. Reload to see the latest version." The page has already refetched: the newer version is listed and the button reads "Save as version 5".
- **Cause:** `MemoryDetailPage.tsx:116-118` refetches on 409 (iOS `MemoryDetailView.save()` does the same); the `memoryPage.detail.conflict` string predates that.
- **Caused by this work.**
- **Fixed on web, 2026-11-06:** it now says "A newer version was saved while you were editing. It's listed now, and your text is still here." `MemoryDetailPage.test.tsx` asserts it.
- **iOS:** same wording problem in `Localizable.strings` (`memoryPage.detail.conflict`). I changed it and then put it back, because iOS fixes wait for your go-ahead.

## MEM-006

**The shared-memory delete dialog's three buttons wrap untidily**

- **Steps:** in a project, delete a memory that is also in another project.
- **Actual:** desktop: the footer is 398px wide but Cancel, Remove from this project and Delete everywhere need 492px, so Delete everywhere drops to a line of its own. Phone: the three buttons stack right-aligned at three different widths.
- **Expected:** one tidy row on desktop; full-width stacked buttons on a phone.
- **Caused by this work** (`DeleteMemoryDialog.tsx`).
- **Fixed, 2026-11-06:** with a shared memory the choices stack full width: Remove from this project, Delete everywhere, Cancel. Measured live: 398px wide on desktop, 301px on a 390px phone. Two-button dialogs are unchanged.

## MEM-007

**Memories never get vectors when the conversations embedding model is multimodal**

- **Where:** `/encode-memory` on the retrieval server, called by the proxy's `MemoryVectorService`.
- **Actual:** the test account's conversations embedding default is `voyage-multimodal-3.5`. Memory encoding embeds with Voyage's text call, which rejects it: "Model voyage-multimodal-3.5 is not supported". Every encode fails and keeps being retried. This account also has no vector DB configured, so it would fail on that next.
- **Effect:** Episodic recall and the model's memory search can never find these memories. Core memories are unaffected (read from DynamoDB).
- **Not caused by this work:** the proxy picks the model exactly as before (`embeddingModelConversations`, then `embeddingModel`).
- **Won't fix (user, 2026-11-06):** "in production we are using voyage-4-large … so shouldn't be issue". It only affects an account whose conversations model is a multimodal one, like this dev account.

## MEM-008

**No use of a memory was ever recorded: no usage rows, hit counter stuck at 0**

- **Steps:** chat with an agent that has a Memory node; a Core memory is used in the reply.
- **Expected:** one usage row per reply and "Used" goes up.
- **Actual:** the reply used the memory, but nothing was recorded. The retrieval server logged "Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ADD, operand type: MAP" for every memory.
- **Cause:** `_write_usage` (`graph/nodes/memory.py`) passed typed values (`{"S": …}`, `{"N": "1"}`) to the boto3 resource's client, which serializes plain Python values itself, so they went out as maps. The unit tests replaced the client, so they missed it.
- **Caused by this work.**
- **Fixed, 2026-11-06:** plain values. New test `UsageWireFormatTests` runs a real boto3 resource client up to the point of sending and checks the hit counter goes out as `{"N": "1"}` (the old code sends `{"M": {"N": {"S": "1"}}}`). Retrieval container rebuilt.
- **Verified live:** after the fix, each Core memory got one usage row per vendor reply and "Used" went 0 → 3 → 6 → 9.

## MEM-009

**A new chat's sent first message comes back as the next new chat's draft**

- **Steps:** start a new chat, send a message, then reload the page or open `/chat` fresh.
- **Expected:** an empty composer.
- **Actual:** the composer holds the message already sent. Typing into it mixes the two, which is how one acceptance message went out as "Acceptance test: what is thAcceptance test: … line.e Test Project codename…".
- **Cause:** component-library `Request.tsx` saved every composer's draft to localStorage (`<customerId>_prompt_editor_content_conv-<blockId>`, 500 ms after typing) and restored it on mount. Nothing cleared it on send; only the web app's New Chat swept it.
- **Not caused by this work.**
- **Fixed in the library, 2026-11-06 (user: "it should not read draft from localstorage"):** `Request.tsx` no longer reads or writes drafts; they live only in the composer. Tests: "never restores a draft from localStorage" and "typing keeps the draft out of localStorage"; library 194 passed, type-check and lint clean. The web app keeps sweeping old draft keys on New Chat, since they hold prompt text.
- **Verified live** with the library build swapped into the app:
  - an old draft key was in localStorage, yet the composer opened empty;
  - typing wrote nothing;
  - after sending a first message, a fresh `/chat` opened empty.

  The published copy was put back afterwards.
- **To ship:** commit the library to `main`, which publishes it, then bump the web app to that version. Waiting for your go-ahead.

## MEM-010

**After a conversation is deleted, "Used N×" stays but the usage log says "Not used in any reply yet"**

- **Steps:** use a memory in a conversation, then delete the conversation.
- **Actual:** the conversation's usage rows are deleted (as planned in B9), but the hit counter isn't, and the usage total comes from the counter. The detail page shows "Used 6×" and "Usage log 6", with "Not used in any reply yet." underneath.
- **Caused by this work.**
- **Decision (user, 2026-11-06):** deleting a conversation takes its uses off the counter, so the counter always equals the usage log.
- **Fixed, 2026-11-06** (`PurgeRepository.deleteMemoryUsageOfConversation`):
  - Each usage row is deleted in one transaction with a −1 on its memory's `hitCount`. A rerun finds the row gone and takes nothing off.
  - A use of a memory that's already gone is still deleted.
  - Any other failure stops the job so it runs again.
  - Then `lastUsedAt` moves back to the newest use left, or is removed, but only while it still names a deleted use.
  - Five new tests in `PurgeRepositoryTest`.
- **Verified live:** a test memory used in 3 replies showed "Used 3×" with 3 rows. After the conversation was deleted it showed 0, no rows and no `lastUsedAt`. Two other memories used in the same replies went 15 → 12.

## MEM-011

**AI Settings still says the priority 1 provider writes "note titles"**

- **Where:** Settings › AI Settings: "Your priority 1 provider also writes chat and note titles and learns facts about you…"
- **Actual:** the apps no longer create notes, so "note titles" no longer means anything to the user.
- **Follows from this work** (notes UI removed).
- **Fixed, 2026-11-06:** now "writes chat titles and learns facts about you". `AISettings.test.tsx` updated. iOS doesn't show this text.

## MEM-012

**Delete in the mobile actions sheet isn't red**

- **Actual:** in the phone actions sheet, Delete had the danger class but showed in the normal text colour: `.sheetAction` is declared after `.menuItemDanger` and overrides it.
- **Caused by this work.**
- **Fixed, 2026-11-06:** `.sheetAction.menuItemDanger` keeps the error colour. Verified in dark (`rgb(255, 107, 107)`) and light.

## MEM-013

**A version you added by hand says "Edited by you"**

- **Steps:** add a memory by hand, edit it once, open the versions list.
- **Expected:** Version 1 "Added by you", Version 2 "Edited by you".
- **Actual:** both say "Edited by you", on web and iOS. A memory with a single version showed it too.
- **Cause:** `versionAuthor` (web `memoryLabels.ts`, iOS `MemoryLabels.versionAuthor`) mapped both `ADDED_BY_YOU` and `EDITED_BY_YOU` to `memoryPage.versions.byYou` = "Edited by you". My own test asserted the wrong text.
- **Caused by this work.**
- **Fixed on web, 2026-11-06:** the versions list uses `changeTitle`, which already words every change type, and the unused `byYou` key is gone. New test "each version says how it was made" covers Added by you, Edited by you and Updated from a conversation.
- **iOS:** open, waiting for your go-ahead (same one-line change in `MemoryLabels`).

## MEM-014

**Delete in the iOS actions sheet uses an archive icon**

- **Where:** iOS Memory list › card ⋮ › Delete (`MemoryPageView.swift:150`, icon `archive`).
- **Expected:** the trash icon, as on the web (`ICONS.TRASH`). Deleting is permanent, so an archive box suggests the wrong thing.
- **Caused by this work.** Open, waiting for your go-ahead.

## MEM-015

**New memory: Save sits half under the keyboard, and there's no Cancel**

- **Steps:** iOS › Memory › Add memory, tap the text box.
- **Actual:** with the keyboard up, only the top edge of Save memory shows above it; the field's return key adds a new line, so there's no obvious way to reach Save without dismissing the keyboard. The web page has Cancel beside Save; iOS has Save only.
- **Caused by this work.** Open, waiting for your go-ahead.

## MEM-016

**Small differences from the web on the Memory screens**

Each was checked against the web at 390px:

- Card menu is a vertical ⋮; the web uses a horizontal ….
- Card dates read "Nov 6"; the web shows "Nov 6, 2026".
- Change log / Usage log is a segmented pill; the web uses underlined tabs.
- New memory puts "Applies in" inside the field; the web labels it above.
- "Not used in a reply yet" sits on its own line under Applies in; the web puts it on the same row.

**Caused by this work.** Open, waiting for your go-ahead.
