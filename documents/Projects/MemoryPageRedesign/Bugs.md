# Bugs: Memory and Instruction detail pages

Found while building or testing this work. Ids are `DP-NNN`. Each bug says whether this work caused it.

| Id | Severity | Status | Where | Title |
|---|---|---|---|---|
| [DP-001](#dp-001) | High | Fixed (verified live) | Proxy | Saving an instruction fails when the AI that names and tags it fails |
| [DP-002](#dp-002) | Medium | Fixed (verified on iOS) | iOS | iOS never loads who an instruction is shared with |
| [DP-003](#dp-003) | Medium | Fixed (verified on phone web and iOS) | Web, iOS | An Episodic memory in Profile says it applies to every conversation |
| [DP-004](#dp-004) | Medium | Fixed (verified on phone web and iOS) | Web, iOS | A memory used before the usage log existed says it was never used |
| [DP-005](#dp-005) | High | Fixed (verified on phone web) | Web | On a phone, an instruction's text runs off the right edge of its card |
| [DP-006](#dp-006) | Low | Fixed (verified on desktop) | Web | The desktop header's ⋯ button is cut off at the right edge |
| [DP-007](#dp-007) | Low | Fixed (verified on desktop) | Web | The memory editor opens with the caret before the text |
| [DP-008](#dp-008) | Low | Fixed (verified on desktop) | Web | A last-used date in the Usage card wraps onto two lines |
| [DP-009](#dp-009) | Medium | Fixed (verified on desktop) | Web | In light mode the desktop header's Share and Move to… are hard to read |
| [DP-010](#dp-010) | Low | Fixed (verified on iOS) | iOS | "Restore as version N" wraps onto two lines |
| [DP-011](#dp-011) | Low | Fixed (verified on iOS) | iOS | A memory page opened cold names the wrong list in its header |
| [DP-012](#dp-012) | High | Fixed (verified on iOS) | iOS | An instruction's numbered and bulleted lists lose their numbers and bullets |
| [DP-013](#dp-013) | Medium | Fixed (verified on iOS) | iOS | The Versions page can show only the latest version, labelled "Created" |
| [DP-014](#dp-014) | Medium | Fixed (verified on iOS) | iOS | On the edit pages the keyboard hides Save and Cancel |

## DP-001

**Saving an instruction fails when the AI that names and tags it fails**

- **Steps:** on an account whose priority-1 provider is OpenAI `gpt-4` (the dev test account), create an instruction, or save a new version of one.
- **Expected:** the instruction is saved.
- **Actual:** 500 after about 18 seconds, and nothing is saved. Proxy log: "All 1 customer AI provider(s) failed for persona-generation: OPENAI/gpt-4", from "The model `gpt-4` has been deprecated".
- **Cause:** `InstructionService.createInstructionWithGeneratedPersona` generates the icon, colour, category, tags and (when none is typed) the name with the customer's AI before saving, and any failure there failed the whole save. It applies to every save, new versions included, so any account with a retired model or no working key could not save instructions at all.
- **Caused by this work:** no. Found while testing it.
- **Fix, 2026-11-06:** a failed generation is logged and the save goes ahead. Verified live on the dev account: both versions of a test instruction saved (200), and version 3 from the phone edit page. On this account a save still takes about 18 seconds, the time the retired `gpt-4` takes to fail; the naming agent's model is account setup, not code. A new version keeps the previous version's icon, colour, tags, category and name; a new instruction with no name is named after its first line. The list endpoint's existing backfill fills in the missing icon and category later. Tests: `InstructionPersonaFallbackTest` (3).

## DP-002

**iOS never loads who an instruction is shared with**

- **Where:** `InstructionService.getInstructionSharedUsers` in `Services/BackendServices.swift`.
- **Actual:** it calls `GET /api/v1/instruction/{id}/shared`, which doesn't exist; the server route is `GET /api/v1/instruction/shared?instructionId=`. The call always fails, so the share dialog on iOS starts empty even when the instruction is shared.
- **Caused by this work:** no. Found while building the Sharing row, which needs this call.
- **Fix, 2026-11-06:** the id goes in the query string, as on the web. Verified on iOS: the share dialog for a shared instruction lists the person ([screenshot](screenshots/ios/I3-share-dialog.png)).
- **Same problem, not fixed:** `getInstructionVersion` also uses a path the server doesn't have (`/instruction/{id}/{version}` instead of `/instruction/version?instructionId=&version=`), but nothing in the app calls it.

## DP-003

**An Episodic memory in Profile says it applies to every conversation**

- **Steps:** open a Profile memory, tap Applies to, pick Episodic, move.
- **Expected:** the Applies to row says the memory is recalled when relevant.
- **Actual:** "Every conversation · Episodic". Only Core memories go into every conversation; Episodic ones are recalled when a conversation calls for them, as the Move dialog itself says. Screenshots: [before](screenshots/web/DP-003-before.png), [after](screenshots/web/DP-003-after.png).
- **Cause:** `appliesLabel` (web) and `MemoryLabels.applies` (iOS) used "Every conversation" for every Profile placement, whatever its kind.
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** Profile Episodic reads "When relevant · Episodic"; Core and project memories are unchanged. Tests: web `appliesLabel`, iOS `onlyCoreInProfileAppliesToEveryConversation`.

## DP-004

**A memory used before the usage log existed says it was never used**

- **Steps:** open an older memory whose list card says "Used 12×" (dev account: "Runs Yusi Scoring Studio…", created Sep 7).
- **Expected:** the detail page and its Used-in page agree with the list: 12 replies.
- **Actual:** the Usage row says "Not used in a reply yet", the Used-in page says "Not used in any reply yet.", and on desktop the Usage card shows 12 next to "not used yet". Screenshots before: [row](screenshots/web/DP-004-before-row.png), [Used in](screenshots/web/DP-004-before-usedin.png); after: [row](screenshots/web/DP-004-after-row.png), [Used in](screenshots/web/DP-004-after-usedin.png).
- **Cause:** the hit counter is older than the usage log and the last-used date. The memory has `hitCount` 12 but no `lastUsedAt` and no log rows, and the new pages treated a missing date as "never used".
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** the Usage row shows the count alone ("12 replies"); the desktop card says "last use not recorded"; once the whole log is loaded, Used in says how many replies came before conversations were listed, alone ("12 replies used it before conversations were listed.") or under the list ("Plus 9 earlier replies…"). Tests: web `MemoryUsedInPage` (2 new, 1 extended), iOS `repliesFromBeforeTheUsageLogAreCountedNotHidden`.

## DP-005

**On a phone, an instruction's text runs off the right edge of its card**

- **Steps:** on a phone-width web page, open an instruction with a few paragraphs and a numbered list.
- **Expected:** the text wraps inside the card; the list numbers sit inside the text column.
- **Actual:** every paragraph is laid out 480px wide and cut off at the card's right edge; the list numbers hang in the card's left padding. Screenshots: [before](screenshots/web/DP-005-before.png), [after](screenshots/web/I1-detail.png).
- **Cause:** the library's `TextContainer` article has `min-width: 30rem`, which it lifts only inside a narrow `@container`. The detail card has no such container, and the card's override reset the width, padding and border but not the min-width. Lists lost their indent because the override also removes the article's padding, which they had been hanging into.
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** the override in `DetailPage.module.scss` also sets `min-width: 0` and gives lists a 1.5rem indent.

## DP-006

**The desktop header's ⋯ button is cut off at the right edge**

- **Steps:** open any memory or instruction on desktop.
- **Expected:** Move to… / Share and ⋯ sit inside the header's 16px padding.
- **Actual:** ⋯ runs 24px past the header's right padding and is clipped by the window edge. Screenshots: [before](screenshots/desktop/DP-006-before.png), [after](screenshots/desktop/M9-memory-columns.png).
- **Cause:** the library `PillButton` has `min-width: min(120px, 100%)`. When the header sizes its actions box, the percentage counts as 0, so the box is sized for the label alone and the button's real 120px width spills over.
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** buttons in the detail header get a plain `min-width: 120px` (`.headerActions` in `DetailPage.module.scss`).

## DP-007

**The memory editor opens with the caret before the text**

- **Steps:** on desktop press Edit (or Restore), or open the edit page on a phone, and type.
- **Expected:** typing continues the memory, as in any editor opened to change existing text.
- **Actual:** the caret is at the start, so what you type goes in front. Screenshot: [before](screenshots/desktop/DP-007-before.png).
- **Cause:** `autoFocus` focuses the text area with the caret at position 0.
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** both editors take a `focusAtEnd` ref that focuses and puts the caret after the text. Test: the desktop edit test checks focus and caret. Verified live: caret at 37 of 37.

## DP-008

**A last-used date in the Usage card wraps onto two lines**

- **Steps:** open a used instruction on desktop.
- **Expected:** "Aug 10, 2026" on one line beside the count.
- **Actual:** at the size of a count the date doesn't fit half the side card and breaks into "Aug 10," / "2026". Screenshots: [before](screenshots/desktop/DP-008-before.png), [after](screenshots/desktop/I9-instruction-columns.png).
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** a stat that is words rather than a count is set at text size on one line, as tall as a count so the labels stay level.

## DP-009

**In light mode the desktop header's Share and Move to… are hard to read**

- **Steps:** light theme, open an instruction or memory on desktop.
- **Expected:** header buttons readable, like New chat and Share in the chat header.
- **Actual:** transparent buttons with dark text (rgb 44,44,44) on the grey header (rgb 104,112,119), about 2.7:1. Screenshots: [before](screenshots/desktop/DP-009-before.png), [after](screenshots/desktop/I10-light.png).
- **Cause:** the pages used the `secondary` PillButton; the library's header buttons use `pageHeaderStyles.actionButton`, which has a solid background.
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** Share and Move to… use `pageHeaderStyles.actionButton` with an icon, as the chat header does.

## DP-010

**"Restore as version N" wraps onto two lines**

- **Steps:** iOS, open an older version of a memory.
- **Actual:** the button reads "Restore as version" / "6" on two lines, because the version note beside it kept its width. Screenshots: [before](screenshots/ios/DP-010-before.png), [after](screenshots/ios/M6-older-version.png).
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** the card footer's button keeps its natural width (`fixedSize`) and the note wraps instead (`DetailCardFoot`).

## DP-011

**A memory page opened cold names the wrong list in its header**

- **Steps:** iOS, open an Episodic memory's page without coming through its list (here, a debug launch straight to it).
- **Actual:** the header says "Core memories", the list remembered from before, not the memory's own. Coming from the list it is right, so users rarely see this. The web falls back to the memory's own list in the same case. Screenshot: [before](screenshots/ios/DP-010-before.png).
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** the memory and edit views switch the remembered list to the memory's own when the memory isn't in it, as a move already did.

## DP-012

**An instruction's numbered and bulleted lists lose their numbers and bullets**

- **Steps:** iOS, open an instruction with a numbered list.
- **Expected:** "1. Who pays…" as on the web.
- **Actual:** the items show with no numbers. Screenshots: [before](screenshots/ios/DP-012-before.png), [after](screenshots/ios/I1-detail-dark.png).
- **Cause:** `MarkdownView` draws list markers 24pt to the left of its frame, as the chat needs, and the instruction card clips its text (for the long-text fade), which cut them off. Same root as web DP-005: lists had no indent of their own.
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** `MarkdownParser.Options` gets `listIndent`; the instruction card uses 24pt, matching the web card's 1.5rem, so markers sit inside the text column. The chat is unchanged (default 0). Test: `detailCardsIndentListsInsideTheTextColumn`.

## DP-013

**The Versions page can show only the latest version, labelled "Created"**

- **Steps:** iOS, open an instruction's Versions page before the Instructions page has loaded every version (a cold start, or a quick tap).
- **Actual:** one entry, "Created v3": `/onboard` brings only each instruction's latest version, and the page used what was loaded. Screenshots: [before](screenshots/ios/DP-013-before.png), [after](screenshots/ios/I5-versions.png).
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** the Versions view loads the full list, as the instruction page already did.

## DP-014

**On the edit pages the keyboard hides Save and Cancel**

- **Steps:** iOS, edit an instruction or a memory and tap into a field.
- **Expected:** Save and Cancel above the keyboard (the agreed design; the web pins them).
- **Actual:** the buttons sit after the content and the keyboard covers them. Screenshots: [before](screenshots/ios/DP-014-keyboard-before.png), [after](screenshots/ios/I6-edit-keyboard.png).
- **Caused by this work:** yes.
- **Fix, 2026-11-06:** `DetailScaffold` takes `actions`, shown in a bar pinned to the bottom with `safeAreaInset`, which moves up with the keyboard; both edit views use it.

## Template

**Title**

- **Steps:**
- **Expected:**
- **Actual:**
- **Cause:**
- **Caused by this work:** yes / no
- **Fix:**
