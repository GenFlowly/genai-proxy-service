# Tasks: Content moderation for shared items

Design: `Plan.md`. Checks: `Acceptance Testing.md`. Problems found: `Bugs.md`. Status: ⬜ not started · 🟦 in progress · ✅ done (code and its tests) · ⛔ blocked.

Built and tested 2026-11-08, committed and pushed to `development` 2026-11-13.

## Backend

| # | Task | Status |
|---|---|---|
| B1 | CDK: `ContentReports` table with `statusCreatedIndex`; `CustomerBlocks` table with `blockedCustomerIdIndex` | ✅ |
| B2 | CDK: `sns:Publish` on the support topic for the proxy's Fly user | ✅ |
| B3 | `ContentFilter`, its word list and `ContentBlockedException` | ✅ |
| B4 | `CustomerBlockRepository`: block, unblock, my blocks, who blocked me, pair check, delete all for an account | ✅ |
| B5 | `ShareRepository`: share rows with `sharedBy`, batch delete, delete all shares of an instruction | ✅ |
| B6 | `BlockService`: block with share removal both ways, unblock, list, `ensureNotBlocked`, the related-customers set | ✅ |
| B7 | `ContentReportRepository`: conditional create, list by status with paging, open count, resolve, reports for one item | ✅ |
| B8 | `SnsNotifier` (no-op without `SUPPORT_TOPIC_ARN`) and `ContentReportService` (create with permission check, snapshot, email; admin actions) | ✅ |
| B9 | Filter at share time, conversation and instruction, specific users and PUBLIC | ✅ |
| B10 | Filter when an instruction that already has shares is saved | ✅ |
| B11 | Filter on a recipient's EDIT post in the generate and stream paths | ✅ |
| B12 | Block checks in both share paths, covering the sharer and the owner | ✅ |
| B13 | Username search: hide blocked users both ways, skip their profile lookups, keep 5 results | ✅ |
| B14 | Public conversations and instructions: hide blocked owners from signed-in viewers, never from signed-out ones | ✅ |
| B15 | Routes: `/reports`, `/blocks`, `/admin/reports`; 422 `CONTENT_BLOCKED` and 403 `BLOCKED` on the share routes | ✅ |
| B16 | `GET /shared-item/owner`: owner ID, username and whether Block applies, for an item shared with the caller | ✅ |
| B17 | Account deletion removes the account's blocks both ways | ✅ |
| B18 | Deploy workflows: `SUPPORT_TOPIC_ARN` per stage | ✅ |
| B19 | Unit tests for B3 to B17 | ✅ |

## Web

| # | Task | Status |
|---|---|---|
| W1 | `moderationService.ts`: report, block, unblock, list; share errors mapped to `CONTENT_BLOCKED` and `BLOCKED` | ✅ |
| W2 | Report dialog and its confirmation with Block and Remove from my list | ✅ |
| W3 | Chat: Report and Block in the phone menu and the desktop header; "Shared by" indicator | ✅ |
| W4 | Instruction detail: Report and Block for items shared with you | ✅ |
| W5 | Share modal: Block on a recipient, content-rules line, filter and block error messages | ✅ |
| W6 | Settings › Profile: Blocked users with Unblock | ✅ |
| W7 | `/content-rules` public page, linked from the share modal, the report dialog and the footer | ✅ |
| W8 | A recipient's blocked post shows the filter message in chat | ✅ |
| W9 | Translations, tests for every changed file, coverage gate, build | ✅ |

## Admin panel

| # | Task | Status |
|---|---|---|
| A1 | `reportsService.ts`, endpoints | ✅ |
| A2 | Reports page: Open and Resolved tabs, table, detail panel, Dismiss, Make private, Resolve | ✅ |
| A3 | Nav entry with the open-report count | ✅ |
| A4 | Type check and build | ✅ |

## iOS

| # | Task | Status |
|---|---|---|
| I1 | `ModerationService`, models, decoding of the owner fields | ✅ |
| I2 | Report sheet and its confirmation | ✅ |
| I3 | Chat header menu: Report and Block; "Shared by" indicator | ✅ |
| I4 | Instruction detail menu: Report and Block | ✅ |
| I5 | Share sheet: Block on a recipient, content-rules line, filter and block error messages | ✅ |
| I6 | Settings › Profile: Blocked users with Unblock | ✅ |
| I7 | A recipient's blocked post shows the filter message in chat | ✅ |
| I8 | Strings, unit tests, build | ✅ |

## Release (user)

| # | Task | Status |
|---|---|---|
| R1 | Committed and pushed to `development` 2026-11-13, PR to `main` open. Merging deploys CDK and proxy, web, admin and the iOS TestFlight build (user) | 🟦 |
| R2 | Privacy policy: what a report stores, and blocks (`Policy.md`, `public/privacy-policy.md`). Ship the published copy with this release | ✅ |
| R3 | Reviewer notes and screen recording show Report and Block on an item shared from a second account. Notes and recording script in `App Review Notes.md` | 🟦 |
