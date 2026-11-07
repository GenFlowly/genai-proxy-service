# Tasks: Memory and Instruction detail pages

The Memory detail page and the Instruction detail page get the same structure: the text as readable content with one Edit action, then a short list of rows (where it applies or who it's shared with, usage, history) that open their own pages on a phone and sit beside the text on desktop.

Design: https://claude.ai/artifact/Qc9etJQdCicDPneeW1SNXr, bottom row. V2 Rows is the phone layout, "V2 · History" and "V2 · Used in" are its child pages, "Desktop · Memory" and "Desktop · Instruction" are the desktop pages.

`[x]` built and exercised, with evidence in `Acceptance Testing.md` · `[~]` built and unit-tested, not exercised end to end yet · `[ ]` not done · `[!]` blocked

Nothing is committed or pushed until the user says so. Bugs go in `Bugs.md`.

## Decisions

"User" rows are the user's calls. "Mine" rows are defaults I picked to keep going; each can be overruled.

| Topic | Decision | Whose |
|---|---|---|
| Layout | V2 Rows on phones: text card with Edit, then rows. Desktop: the two-column page, text and History on the left, the side cards on the right. | User, 2026-11-06 |
| Child pages | The History and Usage rows open their own pages, taken from the V3 design: a timeline with the conversation, what you said, why and the change; a list of conversations. | User, 2026-11-06 |
| Instructions | Same structure as memories, with Sharing in place of Applies to. | User, 2026-11-06 |
| Platforms | Web (phone and desktop) and iOS. | User, 2026-11-06 |
| Fewer options | Delete, and for instructions Share, live in the ⋯ menu. No message ids on the page. No sort or filter controls. | User, 2026-11-06 ("you are giving users a lot of options") |
| Applies to row | Opens the existing Move dialog. | Mine |
| Editing | On a phone, Edit opens an edit page with Save above the keyboard. On desktop, Edit switches the card to an editor in place. Each save is a new version, as before. | Mine, from the design |
| Older versions | "View version N" opens the edit page pinned to that version; saving from it restores the text as a new version, as the API already works. | Mine |
| Instruction usage | The backend keeps a hit count, a last-used time and the conversations that used an instruction, but no count or time per conversation. "Used in" for an instruction is a list of conversation names. | Mine, from the data |
| Instruction history | One entry per version: "Created" and "Edited", with the version's date. Instructions have no change log beyond their versions. | Mine, from the data |
| Component library | Not changed. The phone edit page is built from the library's existing inputs and text editor. | Mine |
| Back on web phone pages | The library's phone header has only the menu button, so the web edit, history and used-in pages put a "‹ Memory" / "‹ Instruction" link at the top of the content. iOS gets a real back button. Changing the library header would need a library release. | Mine |
| Instruction usage list | Lists at most 50 conversations (each needs a title lookup) and says how many it left out. | Mine |

## Phase 1: Backend (proxy)

- [x] B1. `GET /instruction/{id}/usage`: the caller's own count, last use, and up to 50 conversations newest first with live titles; `omitted` counts the rest. Anyone who can see the instruction; 404 otherwise. New usage rows record `seenAt` so conversations get a date from now on.
- [x] B2. `createdAt` on each instruction version (already stored, now returned).
- [x] B3. Tests: `InstructionUsageServiceTest` (7), `InstructionUsageDedupTest` (+1), `InstructionPersonaFallbackTest` (3, DP-001). Full proxy suite 2026-11-06: 582 passed, 0 failed.

## Phase 2: Web, memory

- [x] WM1. Shared detail components (`components/DetailPage`): page shell, two columns, rows, side cards, stats, timeline, conversation list, more menu, word diff.
- [x] WM2. Memory detail page rebuilt: phone rows, desktop two columns, Edit in place on desktop, `?version=N` older version with Restore.
- [x] WM3. Edit page `/memory/:id/edit` (with `?version=`), with a live preview of the change.
- [x] WM4. History page `/memory/:id/history` and Used-in page `/memory/:id/usage` (grouped by conversation).
- [x] WM5. Tests (memory pages 21, after the acceptance fixes), coverage gate, strict build. Full web suite 2026-11-06: 133 suites, 1079 passed; changed-code coverage 87% lines; build passes.

## Phase 3: Web, instructions

- [x] WI1. Instruction detail page rebuilt on the shared components: formatted text (clipped on phones), Sharing/Usage/Versions rows, desktop Sharing and Usage cards, Share and ⋯ Delete in the header.
- [x] WI2. Edit page `/instructions/:id/edit` and `/instructions/new` from the library name input and text editor; Edit in place on desktop.
- [x] WI3. Versions page `/instructions/:id/history` (each version's change against the one before) and Used-in page `/instructions/:id/usage`.
- [x] WI4. Tests (instruction pages 21, diff and parts 7), coverage gate, strict build.

## Phase 4: iOS

- [x] IM1. Memory detail as rows; edit, history and usage views; routes (`memoryEdit`, `memoryHistory`, `memoryUsage`, `memoryDetail` with `version`); the header's left button goes back on child pages; Save and Cancel pinned above the keyboard (DP-014).
- [x] II1. Instruction detail as rows (formatted text, clipped when long, lists indented: DP-012); edit, versions and usage views; routes. New instructions open the edit view.
- [x] I3. Unit tests: 309 passed, 0 failed, including `DetailPageTests` (8: the first 5 plus DP-003, DP-004 and DP-012); builds clean with the local stage.

## Phase 5: Acceptance

- [x] A1. Every row of `Acceptance Testing.md` on phone web, desktop web and iOS, with screenshots in `screenshots/`, 2026-11-06. Found and fixed DP-003 to DP-009 (web) and DP-010 to DP-014 (iOS).
- [ ] A2. Remove the acceptance test data from the dev account: the `[acceptance]` memory and instruction, and the two `[acceptance]` chats sent for M4 (`32d95565-…`, `3403a527-…`).

## Release (only when the user says so)

1. Commit with explicit paths on `development`; PR to `main`.
2. Deploy the proxy before the web app: the instruction page's Usage row needs B1.
3. iOS build.

## Open questions

None open.
