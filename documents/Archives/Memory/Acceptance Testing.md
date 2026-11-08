# Acceptance Testing: Memory page

**How it was run (2026-11-06)**

- **Stack:** fresh local `ktor-app` and `retrieval-server` containers built from this working tree, against the dev AWS account. The compose file sits in the session scratchpad.
- **Desktop web:** the app at `localhost:3000` in Chrome, rendered in a 1280px frame. The Chrome window couldn't be widened past 500px, so layout was checked by measuring the DOM, not by eye. Light theme checked on the list, detail and Move dialog.
- **Mobile web:** the same app in a 390×844 frame. Nothing in the Memory code depends on `(hover: none)`, so it wasn't forced. Light theme checked on the actions sheet and L2 Menu.
- **iOS:** the local build (installed app checked: `API_BASE_URL` = `http://localhost:8080`) on the iPhone 17 Pro simulator, driven with idb taps. The simulator was signed in to another dev account (`CU967B18A769BB`, which another session also uses), not the web test account. It has no projects, and I didn't create any there, so the project rows weren't run on iOS. No chat was run on iOS. The app uses its own light theme setting, so iOS was checked in light only. Every memory I added there was deleted; its memory table is empty again.
- **Status:** ✅ works and looks right · 🟡 works apart from the note · ❌ fails (with a bug id) · Not run · n/a
- **Read-back:** every write was read back from the API (`/memories`, `/memories/{id}`, `/usage`), and deletes from DynamoDB.
- **Test data:** memories and conversations I created are prefixed "[acceptance]"; the account's existing projects (Bugs, Memories, Test Project) were used as targets.

**What this account can't test:** the dev account has no vector DB and its conversations embedding model is `voyage-multimodal-3.5`, so memories never get vectors (MEM-007). Episodic recall, the model's memory search and L2 Menu search can't return anything for it. Core memories don't need vectors and were tested in full.

**Agent note:** memories only reach a chat through an agent whose graph has a Memory node. The account's selected "Converation Agent" (`GRP432634C9B41C`) has none; it is deprecated (user, 2026-11-06), so it's ignored. The chat checks ran on the System default "Agent" (`GRP7C7B8B103694`), picked through this browser's localStorage only, and the old selection was restored afterwards.

## Navigation and L2 Menu

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| N1 | Opening Memory lands on Profile · Core | ✅ | ✅ | ✅ | `/memory` shows "Core memories", "Profile · included in every conversation" |
| N2 | Sidebar (desktop) or L2 Menu (mobile) shows a Profile card with Core and Episodic, and a Projects card listing every project with counts | ✅ | ✅ | ✅ | Core 2 / Episodic 3; Bugs, Memories, Test Project; counts update after each write; iOS account has no projects: "No projects yet" |
| N3 | Rows open their list; they don't expand | ✅ | ✅ | ✅ | Rows are buttons that set `?scope=`; on mobile the menu closes |
| N4 | L2 Menu: Add memory pill in the top bar, collapsible card headers, search pill at the bottom | n/a | ✅ | ✅ | Screenshot, dark and light |
| N5 | L2 Menu search finds memories and opens the one tapped | n/a | 🟡 | Not run | Shows "Search isn't set up. Connect a vector DB to search." with Open Settings: correct for this account, but finding and opening weren't testable (MEM-007) |
| N6 | Header shows the list's title and where it applies ("in every conversation" / "only in this project") | ✅ | 🟡 | 🟡 | At 390px the project subtitle is clipped: "…used only in this project's conversati…"; iOS clips it the same way: "Profile · recalled when a conversation calls for…" |

## Lists

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| L1 | Cards show category, text, "Used N×", version and date, newest first | ✅ | ✅ | ✅ | DOM text of every card; hand-added memories have no category tag; iOS dates read "Nov 6" (MEM-016) |
| L2 | Desktop cards sit on the 12-column grid (3 / 2 / 1 per row as the panel narrows) | ✅ | n/a | n/a | Measured: 3 per row at a 1361px panel, 2 at 941px and 864px; 1 needs a panel under 640px |
| L3 | Project cards also show Core or Episodic | ✅ | ✅ | Not run | |
| L4 | Empty project shows the empty state | ✅ | Not run | Not run | "No memories in this project yet" |
| L5 | No sort chips anywhere | ✅ | ✅ | ✅ | No sort controls in the DOM |
| L6 | A memory learned in chat appears without reloading the app (on reopening the page) | ✅ | Not run | Not run | Chat → Memory through the navbar, 73s after the page loaded: the learned memory was first in Core |

## Add memory

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| A1 | Add memory to Profile · Core: appears in that list as version 1 | ✅ | Not run | ✅ | API: `PROFILE:CORE`, version 1, tracked |
| A2 | Add memory to a project as Episodic: appears only in that project | ✅ | ✅ | Not run | Add memory from a project preselects it; API shows that placement only |
| A3 | Change log shows "Added by you" | ✅ | ✅ | ✅ | `ADDED_BY_YOU`, version 1 |
| A4 | Empty text can't be saved | ✅ | ✅ | ✅ | Save stays disabled for empty and spaces-only text; iOS: Save sits half under the keyboard (MEM-015) |

## Edit and versions

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| E1 | Editing opens the detail page; Save creates version N+1 | ✅ | ✅ | ✅ | "Saved as version 2" toast; API versions |
| E2 | Earlier versions are listed and open read-back exactly as saved | ✅ | Not run | 🟡 | Version 1 text identical to the API's v1; Version 1 added by hand reads "Edited by you" on web and iOS (MEM-013; fixed on web) |
| E3 | Saving while viewing an old version creates a new version; the old one is unchanged | ✅ | Not run | ✅ | v3 = v1's text; v1 and v2 unchanged in the API |
| E4 | A save that races another change is refused with a clear message, nothing lost | ✅ | Not run | Not run | API 409 "Version 4 was saved after the one you edited"; draft kept; page shows v4 and "Save as version 5". The message wrongly said to reload: fixed (MEM-005) |
| E5 | A memory from before this work shows one version and "History before … wasn't recorded" | ✅ | Not run | Not run | "Learned before changes were recorded", "History before Sep 7, 2026 wasn't recorded", with its source conversation. Viewing wrote nothing: no change rows exist for older memories |

## Change log

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| C1 | Learned from a conversation: conversation (opens it), message id, what you said, reason | ✅ | Not run | Not run | "Learned from a conversation", the message, "You said" quote, reason "User asked the assistant to remember the project's regular deploy window." |
| C2 | Updated from a conversation: the same, plus before and after | ✅ | Not run | Not run | Tuesday 3pm → Wednesday 4pm, same project and kind |
| C3 | Edited by you: before and after | ✅ | ✅ | ✅ | |
| C4 | Moved / copied / removed from a project: from and to, marked as no new version | ✅ | ✅ | ✅ | "Moved by you · No new version", "Copied by you", `REMOVED_FROM_PROJECT` |
| C5 | After deleting the source conversation: entry stays, "what you said" is gone, conversation shows as deleted | ✅ | ✅ | Not run | "Deleted conversation"; message id and reason kept; no quote |

## Usage log and hit counter

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| U1 | A Core memory used in a reply adds one row (conversation, message, time) and "Used" goes up by one | ✅ | Not run | Not run | Failed at first: nothing was ever recorded (MEM-008, fixed). After the fix: one row per vendor reply, "Used" 0 → 3 → 6 → 9 across three turns |
| U2 | An Episodic memory recalled for a reply is counted the same way | Not run | Not run | Not run | Needs vectors: not possible on this account (MEM-007). Unit-tested |
| U3 | A memory found by the model's memory search is counted | Not run | Not run | Not run | Same; the tool was never called. Unit-tested (also MEM-002) |
| U4 | Retrying or regenerating with failover doesn't double-count a reply | n/a | n/a | n/a | Backend tests; rows are keyed by reply, so a retried write is refused |
| U5 | Usage log pages with Load more; rows open the conversation | 🟡 | Not run | Not run | Rows open `/chat/<id>`. Load more not reachable (9 rows, pages of 25); API paging checked: 4 + 4 + 1, newest first, no repeats. Deleting a conversation takes its uses off the counter (MEM-010, fixed): 3 → 0 live, with `lastUsedAt` removed |

## Move and copy

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| M1 | Move Profile Core → Episodic | ✅ | Not run | ✅ | API placement and `MOVED` entry; version unchanged |
| M2 | Move Profile → project: no longer used outside the project | ✅ | Not run | Not run | Placement read back; project memories confirmed unused elsewhere by S3 |
| M3 | Move project → Profile: used everywhere, its project references are gone | ✅ | ✅ | Not run | From two projects to `PROFILE:CORE` in one `MOVED` entry |
| M4 | Move project → project | ✅ | Not run | Not run | |
| M5 | Copy project → project: shows in both, same versions, same change log, same counter; an edit shows in both | ✅ | ✅ | Not run | One memory id with two placements (kind can differ); an edit made from Bugs showed in Test Project |
| M6 | Copy is not offered on Profile memories | ✅ | Not run | ✅ | Card menu and detail header; a second copy to the same project is refused (400) |
| M7 | Versions and change log are unchanged after a move or copy, apart from the new entry | ✅ | ✅ | ✅ | 11 entries after 5 placement changes: all text entries untouched |

## Delete

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| D1 | Delete a Profile memory: gone from the list and from the API, its vectors deleted | ✅ | ✅ | ✅ | DynamoDB: 0 `MEM#`, `MEMCHG#` and `MEMUSE#` rows; proxy logged the vector delete; iOS: twice; the account's memory table was empty afterwards |
| D2 | Memory in two projects: "Remove from this project" keeps it in the other | ✅ | ✅ | Not run | Dialog layout fixed (MEM-006) |
| D3 | Memory in two projects: "Delete everywhere" removes it from both | ✅ | Not run | Not run | Detail and usage answer 404 |
| D4 | Delete a learned fact from a chat reply (MEM-001) | ✅ | Not run | Not run | ✗ in "1 fact added to memory" deleted it: API 404, vectors deleted |
| D5 | Settings › Delete all learned facts also removes change and usage logs | n/a | n/a | n/a | Not run: it would delete this account's real memories. Backend tests |

## Memories in chat

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| S1 | A chat outside any project learns into Profile | ✅ | n/a | Not run | "Keeps a pet quokka named Pip…" → `PROFILE:CORE`; the conversation has no project |
| S2 | A chat in project A learns into project A | ✅ | n/a | Not run | "Test Project deploy window is Tuesdays at 3pm." → Test Project · Episodic |
| S3 | A chat in project B is never given project A's memories | n/a | n/a | n/a | In a Bugs conversation both replies said the Test Project codename is unknown; the BLUEFIN memory has no usage rows from it |
| S4 | Profile memories are used in every chat, in and out of projects | ✅ | n/a | Not run | The metric preference was used in Test Project and Bugs conversations (rows from both) |
| S5 | Someone you shared a project conversation with doesn't get your project memories | n/a | n/a | n/a | Backend test |

## Notes removed

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| R1 | No notes editor, saved-notes list or New note anywhere | ✅ | ✅ | ✅ | Memory, Chat and every Settings section |
| R2 | No request to `/api/v1/notes` during a full session | ✅ | ✅ | ✅ | Proxy log for the whole session: 0 of 420 API requests |
| R3 | Settings no longer shows "Learn from notes" or the Notes embedding model | ✅ | Not run | Not run | Defaults: "Learn from my chats", "Use learned facts in replies"; embedding defaults list Conversations only. Stale "note titles" copy fixed (MEM-011) |

## Errors and empty states

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| X1 | List fails to load: error state with retry | 🟡 | Not run | Not run | Seen live while the backend had bad AWS credentials: "Couldn't load your memories." with Try again, and "Couldn't load your projects". Try again wasn't pressed |
| X2 | Signed out: sign-in prompt instead of the page | Not run | Not run | Not run | Not run on web: it would sign this browser out |
| X3 | Opening a deleted memory's link shows "not found", not a blank page | ✅ | Not run | Not run | "This memory doesn't exist anymore." with Back to memories |

## Automated tests

| Suite | Result |
|---|---|
| Proxy server (`./gradlew test`) | ✅ 571 passed, 0 failed (2026-11-06, after the MEM-010 fix) |
| Retrieval server (`python -m unittest discover -s tests -t .`) | 🟡 702 run after the MEM-008 fix, 1 error: `test_image_normalize` reads Linux's `/proc` and can't run on macOS (untouched by this work; CI runs Linux). `test_memory_scope.py`: 11 passed, including the new wire-format test |
| Web (`npm test`, `npm run test:diff`, `CI=true npm run build`) | ✅ after the acceptance fixes: 1049 passed; changed-code coverage 94% statements, 93% functions, 87% branches (gate passes); strict build passes |
| iOS (`xcodebuild test`, AI WrapperTests) | ✅ 185 passed, including the new Memories suite; app builds clean with the local stage |
