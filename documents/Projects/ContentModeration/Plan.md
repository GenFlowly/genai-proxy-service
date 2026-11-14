# Content moderation for shared items

Report, Block and a word filter for everything one user can show another: conversations and instructions shared by username, made public, or edited by a recipient with EDIT role. Built for App Store guideline 1.2 (user-generated content), which asks for four things: a way to filter objectionable material before it is posted, a way to report content with timely responses, a way to block abusive users, and published contact information. Contact information is done (`/support`). This project is the other three.

Status: built and tested on the local stack 2026-11-08; committed to `development` 2026-11-13, not yet in production. The work list is `Tasks.md`, the checks are `Acceptance Testing.md`, problems found are `Bugs.md`. Screens: [mockups](https://claude.ai/artifact/LYkJRgdnxRoenU9DJomzP6).

## What exists today

| Piece | Where |
|---|---|
| Share rows | `SharedConversations` (conversationId + sharedWithCustomerId, GSI `conversationIdIndex`) and `SharedInstructions` (entityId + sharedWithCustomerId); `sharedByCustomerId` and `role` (VIEW/EDIT) on each row. `PUBLIC` is a pseudo customer ID. `genai-proxy-server/.../repository/ShareRepository.kt` |
| Share endpoints | `POST/DELETE /api/v1/conversation/share`, `GET /conversation/shared`, same for `/instruction/...`. Activities under `activity/conversation/CreateConversationShareActivity.kt` and `activity/instruction/CreateInstructionShareActivity.kt` |
| Role resolution | `ConversationService.getConversationRole` (OWNER, direct share, then PUBLIC); `InstructionService` resolves the same way. Every write path for a recipient already goes through it |
| Username search | `GET /api/v1/users/search` (`activity/customer/SearchActivity.kt`). Only profiles with `isDiscoverable = true` are returned, and the flag defaults to false. Users opt in under Settings › Profile. Worth saying in the reviewer notes |
| Share UI | Web `components/common/ShareModal/ShareModal.tsx` (PRIVATE / PUBLIC / SPECIFIC) opened from `ConversationHeader.tsx` and `InstructionDetailPage.tsx`; iOS `Views/Chat/ShareSheetView.swift` opened from the chat header menu (`ChatView.swift`, `ConversationHeader`) and `Views/Instructions/InstructionDetailViews.swift` |
| Support email | SNS topic `gen-ai-proxy-service-<stage>-support-requests` from `genai-proxy-server-cdk/lib/support-stack.ts`, delivered to `customer-support@genflowly.com`. The proxy has no SNS client yet |
| Admin panel | `admin-panel/src/App.tsx` nav + routes, one `services/*Service.ts` per page, proxy routes under `/api/v1/admin/*` guarded by `requireAdminCustomerId` |
| Proxy AWS access | IAM user in `genai-proxy-server-cdk/lib/flyio-iam-stack.ts` (DynamoDB, S3, KMS). No `sns:Publish` yet |

## Design

### 1. Filter (before content reaches others)

A server-side word-list check, `ContentFilter` in the proxy, English only, list in `src/main/resources/content-filter/`. Normalises case, strips punctuation and common letter substitutions, matches whole words. Returns the matched terms for the log, never to the client.

Checked at the moments content becomes visible to someone else:

| Moment | Content checked | Where |
|---|---|---|
| Share a conversation with a user or PUBLIC | title and every message text | `CreateConversationShareActivity` before the share row is written |
| Share an instruction with a user or PUBLIC | name and instructions text | `CreateInstructionShareActivity` |
| Update an instruction that already has shares | new name and text | `InstructionService` update path |
| A recipient with EDIT posts into a shared conversation | the new prompt | generation activities, after `getConversationRole` resolves to EDIT (no extra query) |

Refused with `422 { "code": "CONTENT_BLOCKED" }`. Clients show "This can't be shared because it contains language that breaks our content rules." and leave the item private.

Not checked: the owner's later messages into a conversation that is already shared (would cost a share lookup on every message; Report covers it), AI responses, memory, notes. Decision for the user, see below.

### 2. Report

Anyone signed in who can see an item but does not own it can report it: conversation or instruction, with an optional message ID for conversations so the admin sees the exact message.

- `POST /api/v1/reports` `{ entityType: CONVERSATION | INSTRUCTION, entityId, messageId?, reason, details? }`. Reasons: `SPAM`, `HARASSMENT`, `HATE`, `SEXUAL`, `VIOLENCE`, `ILLEGAL`, `OTHER`; details up to 1000 characters. The caller must have a non-owner role on the item (403 otherwise). One report per reporter per item (conditional put; a second attempt returns the first).
- Table `ContentReports`: PK `entityId`, SK `reporterCustomerId`; attributes `entityType`, `messageId`, `ownerCustomerId`, `ownerUsername`, `reporterUsername` (both as they were when the report was filed, so lists need no profile joins), `reason`, `details`, `contentSnapshot` (title/name plus the first 2,000 characters of the reported text, so the admin can judge it even after an edit or deletion), `status` (`OPEN`, `RESOLVED`), `createdAt`, `resolvedAt`, `resolvedBy`, `resolution` (`DISMISSED`, `MADE_PRIVATE`, `RESOLVED`), `resolutionNote`. GSI `statusCreatedIndex` (`status`, `createdAt`) for the admin list.
- Email: after the row is written, publish to the existing support SNS topic (subject `[Report] <type> <reason>`, body with the IDs, reporter, owner, snapshot). Best effort, failure logged, the report still counts. Needs the `sns` SDK in the proxy, `sns:Publish` on `arn:aws:sns:*:*:gen-ai-proxy-service-*-support-requests` in the Fly IAM user, and `SUPPORT_TOPIC_ARN` in the proxy's environment through the deploy workflows. Development reports go to the same inbox with `[development]` in the subject, as support does.
- Admin: `GET /api/v1/admin/reports?status=OPEN`, `POST /api/v1/admin/reports/{entityId}/{reporterCustomerId}` `{ action: DISMISS | MAKE_PRIVATE | RESOLVE, note }`. `MAKE_PRIVATE` removes every share of the item (owner keeps it). Admin panel page "Reports": table of open reports with the snapshot, the three actions, a Resolved tab.
- Cost of the admin list: one `Query` on `statusCreatedIndex` with `status = OPEN`, newest first, `Limit` = the page size (25), paged with `LastEvaluatedKey`. Reads scale with the page, never with the table. All open reports share one partition key; at this volume that is nothing (a page of 25 small rows is about 1 RCU, a partition allows 3,000 RCU/s). Usernames come from the row, so no joins. Each admin action is one `UpdateItem` by (`entityId`, `reporterCustomerId`). `MAKE_PRIVATE` adds one `Query` on the item's share GSI (`conversationIdIndex`, or the instruction GSI) and one `BatchWriteItem` that deletes those rows, so N recipients cost one round trip.
- After reporting, the confirmation offers "Block <username>" and "Remove from my list" (leave the share, which `deleteConversation` already does for recipients).
- Response time commitment in the reviewer notes: "promptly" unless the user wants a number.

### 3. Block

- Table `CustomerBlocks`: PK `blockerCustomerId`, SK `blockedCustomerId`, `createdAt`, `blockedUsername` (as it was at block time, so the Blocked users list renders without joins). Both directions are one `Query` each: "who did I block" is the base table with `blockerCustomerId = me` (the Blocked users page and every filter below); "who blocked me" is the GSI `blockedCustomerIdIndex` with `blockedCustomerId = me`. A single pair check (`ensureNotBlocked(a, b)`) is one `BatchGetItem` of the two keys (`a→b`, `b→a`) on the base table, no GSI. Lists are expected to stay in the tens, so each query is one page.
- `GET /api/v1/blocks` (with usernames), `POST /api/v1/blocks { customerId }`, `DELETE /api/v1/blocks/{customerId}`.
- Effects, in both directions (A blocks B):
  - Username search: B never sees A in results and A never sees B. Today a search is one `Query` on the `UsernameLookup` GSI (prefix match, `Limit 5`) plus one profile lookup per hit for `isDiscoverable`. The block filter adds two small `Query` calls per search request (my blocks, who blocked me), run once and turned into a set; hits are dropped in memory, so the cost does not grow with the number of results. The prefix query's limit goes from 5 to 10 so hidden hits don't empty the list, trimmed to 5 after filtering.
  - Sharing: `POST .../share` from either to the other is refused, `403 { "code": "BLOCKED" }`.
  - Existing shares between them are removed when the block is created: every conversation or instruction A shared with B and B shared with A. Resolved by walking each side's shared-item IDs and comparing owners.
  - Public items, signed-in viewers only: in public listings and when opened by link, items owned by a user the viewer has blocked, or who blocked the viewer, are hidden. A direct link gets the same "Access denied" as any conversation the viewer can't open. Signed-out viewers have no identity to check, so public links keep working for them exactly as today. A blocked user can therefore still open a public item by signing out; that is the accepted limit of blocking on public content. The listing filter reuses the two block queries above, once per request.
  - Not covered: B's messages inside a third person's conversation that both can see. Apple does not ask for this; noted as a later step if needed.
- `BlockService.ensureNotBlocked(a, b)` is the one helper every path calls.
- UI: "Block <username>" in the chat header menu and instruction detail menu for items shared with you (next to Report), in the share modal's people list (the owner blocking a recipient), and in the report confirmation. Settings › Profile gets a "Blocked users" list with Unblock, web and iOS.
- Account deletion removes the account's rows in `CustomerBlocks` both ways (`ContentDeletionService`). Reports stay for the admin record. Both need a line in the privacy policy, which is the user's to edit (`Policy.md`, `public/privacy-policy.md`).

### 4. Content rules (small, recommended)

A short public page `/content-rules` on the web app (no harassment, hate, sexual content involving minors, spam, illegal content; reports reviewed promptly; repeat offenders lose sharing). The share modal (web and iOS) gets one line under the Save button: "By sharing you agree to the content rules" with the link, and the Report sheet links it too. Reviewers look for this even though the guideline text does not name it.

## What changed while building

- Owner details come from `GET /shared-item/owner`, called only for items the viewer doesn't own, instead of being added to the conversation and instruction responses. Instruction lists and every owner's page load stay as they were.
- That endpoint also says whether the item can leave the viewer's list: an item that is only public can't.
- A view-only recipient can now take themselves off an instruction. Before, only owners and editors could call that route.
- The report snapshot keeps the most recent messages, up to 8,000 characters, because the Report menu is per conversation rather than per message.
- A role change for someone already shared with skips the filter, so the "stays private" message is never shown for an item that is already shared.
- Reads of `CustomerBlocks` treat a missing table as no blocks, so a local stack on the shared dev account keeps working until the CDK deploy creates it.

## Decisions

Accepted as proposed when the user said "build the entire thing" (2026-11-08):

1. Filter scope: share time, public time, shared-instruction edits and EDIT-role posts only. The owner's later messages into an already-shared conversation are not filtered (Report covers them). Alternative: a share lookup on every message in a conversation that is not brand new.
2. Word list: an English public list, whole-word matching. False positives are possible (place names, medical terms); the error message never shows the matched word.
3. Report reasons as listed, and "promptly" as the wording, with no number of hours.
4. Block removes existing shares in both directions and hides public items both ways.
5. Content rules page + the one-line notice in the share modal: in.
6. Blocked users list lives under Settings › Profile.

- 2026-11-08 review: blocks apply to signed-in viewers only; public links stay public for anonymous visitors (user).
- 2026-11-08 review: usernames are copied onto report and block rows at write time so the admin list and the Blocked users page need no profile joins; the IDs stay the source of truth.
