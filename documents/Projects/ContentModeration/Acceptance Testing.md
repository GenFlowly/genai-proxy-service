# Acceptance Testing: Content moderation for shared items

**How it was run (2026-11-08)**

- **Stack:** an isolated stack with no contact with the dev or production accounts: DynamoDB Local with all 32 tables created from the CDK template, the proxy built from this working tree on port 8091, a local stand-in for Auth0's signing keys, and a local stand-in for SNS. Only the scratch copy of the proxy was pointed at those stand-ins. All of it was removed afterwards.
- **Accounts:** throwaway accounts with signed test tokens, one set per run. Conversations were written directly to the local database, because the accounts have no AI key.
- **API:** 57 scripted checks with read-back from the tables.
- **Web:** the real app in Chrome driven by script, at 1280×800 and at 390×844 with touch, as owner, recipient and signed out. Dark mode checked by screenshot.
- **Admin panel:** the real panel in Chrome at 1280×800.
- **iOS:** the Debug build on a throwaway iPhone 17 Pro simulator, installed app confirmed pointing at the local stack, driven with idb. Dark mode checked by screenshot.
- **Unit tests on the final code:** proxy 663, web 1,247, iOS suite passing, web coverage gate passing, web CI build and admin build passing.
- **Status:** ✅ works and looks right · 🟡 works apart from the note · ❌ fails (with a bug id) · Not run · n/a

**Not exercised:** real Auth0 sign-in, real SNS email delivery, the deployed tables and the IAM permission, and a full AI reply, since the test accounts have no key. Those need the deploy.

**Missing table:** with `CustomerBlocks` deleted, the instruction list and username search still returned 200. That is the state of a local stack on the dev account before the CDK deploy. Report and Block themselves fail there until the deploy.

**Differences from the mockups:** on web phones, Block is not red (CM-007). The "View only" bar in place of the composer was not built, because Regenerate and Follow up were already disabled for view-only users. Phone web and iOS show Blocked users on its own page, and desktop shows it in Settings › Profile, as designed.

## Filter

| # | Check | API | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|---|
| F1 | Sharing a clean conversation with a user works | ✅ | Not run | Not run | Not run | API 200. The dialog's success path didn't change |
| F2 | Sharing a conversation whose message or title has a listed word is refused and the conversation stays private | ✅ | ✅ | ✅ | ✅ | 422 `CONTENT_BLOCKED`, recipient still denied; toast read on each screen |
| F3 | Making that conversation public is refused too | ✅ | ✅ | ✅ | ✅ | Signed-out request still denied |
| F4 | The error never shows the matched word | ✅ | ✅ | ✅ | ✅ | Response body and toast text |
| F5 | Disguised spellings are caught (case, punctuation, letter swaps, repeated letters) | ✅ | n/a | n/a | n/a | SH1T, s.h.i.t, shiiiiit, F U C K, a$$ |
| F6 | Innocent words containing a listed word pass (for example "assess", "Scunthorpe") | ✅ | n/a | n/a | n/a | Also "magna cum laude", "how to kill a process" |
| F7 | Sharing an instruction with a listed word is refused | ✅ | ✅ | n/a | n/a |  |
| F8 | Saving a listed word into an instruction that already has shares is refused; into a private one it is allowed | ✅ | ✅ | n/a | n/a | Owner and editor refused, private save 200 |
| F9 | A recipient with EDIT posting a listed word is refused and the message isn't saved | ✅ | Not run | Not run | Not run | API: 422, message count unchanged. The test accounts have no AI key, so Follow up is disabled in the apps. Web and iOS message handling is unit-tested |
| F10 | The owner posting a listed word in their own conversation is allowed | ✅ | n/a | n/a | n/a | Passes the filter and stops at "API key not found" |

## Report

| # | Check | API | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|---|
| R1 | A recipient sees Report on a shared conversation | n/a | ✅ | ✅ | ✅ |  |
| R2 | A recipient sees Report on a shared instruction | ✅ | ✅ | ✅ | ✅ |  |
| R3 | The owner sees no Report on their own item | ✅ | ✅ | ✅ | ✅ | API 403 |
| R4 | Sending needs a reason; details are optional and capped at 1,000 characters | ✅ | ✅ | ✅ | 🟡 | API refuses bad reason and 1,001 characters. iOS rule is unit-tested; the disabled button wasn't checked on the simulator |
| R5 | A report is stored with both usernames and a content snapshot | ✅ | n/a | n/a | n/a | Read back from the table |
| R6 | Reporting twice keeps one report | ✅ | n/a | n/a | n/a | `created: false`, no second email, first details kept |
| R7 | Someone with no access to an item can't report it | ✅ | n/a | n/a | n/a | 403 |
| R8 | A signed-in viewer of a public item can report it | ✅ | n/a | n/a | n/a |  |
| R9 | The report email goes to the support topic, and a send failure doesn't lose the report | 🟡 | n/a | n/a | n/a | Against a local stand-in for SNS, including a forced 500. Real SNS not exercised |
| R10 | The confirmation offers Block and Remove from my list, and both work | n/a | ✅ | ✅ | ✅ | Read back from the API, conversations and instructions |

## Block

| # | Check | API | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|---|
| K1 | Block is offered on an item shared with you | n/a | ✅ | ✅ | ✅ | Conversation and instruction; asks first |
| K2 | Block is offered on a recipient in the share dialog | n/a | ✅ | ✅ | ✅ |  |
| K3 | Blocking removes existing shares in both directions, conversations and instructions | ✅ | n/a | n/a | n/a | Owners keep their items; shares from a third person stay |
| K4 | Neither side finds the other by username | ✅ | ✅ | n/a | n/a | Other people are still found |
| K5 | Neither side can share with the other | ✅ | n/a | n/a | n/a | 403 `BLOCKED` |
| K6 | An editor can't share a blocked owner's item with the person who blocked them | ✅ | n/a | n/a | n/a |  |
| K7 | A blocked owner's public conversation is denied to a signed-in viewer | ✅ | n/a | n/a | n/a | Before 200, after 403, other viewers 200 |
| K8 | A blocked owner's public instruction is hidden from a signed-in viewer's list and detail | ✅ | n/a | n/a | n/a | List read back; detail is unit-tested |
| K9 | A signed-out viewer still opens the public conversation | ✅ | ✅ | ✅ | n/a |  |
| K10 | Blocked users lists the person, and Unblock restores search and sharing, not the old shares | ✅ | ✅ | ✅ | ✅ |  |
| K11 | You can't block yourself or PUBLIC | ✅ | n/a | n/a | n/a | 400, unknown user 404 |
| K12 | Deleting an account removes its blocks both ways | ✅ | n/a | n/a | n/a | Rows gone from the table after the job ran |

## Admin

| # | Check | API | Admin panel | How confirmed |
|---|---|---|---|---|
| A1 | Non-admins are refused | ✅ | n/a | 403 on list and action |
| A2 | Open reports list newest first, with paging | ✅ | ✅ | Paged with limit 2; bad cursor 400 |
| A3 | Selecting a report shows its snapshot and the reporter's note | n/a | ✅ |  |
| A4 | Dismiss moves the report to Resolved and leaves the shares | ✅ | ✅ | Acting twice 409, missing 404 |
| A5 | Make private removes every share and resolves every open report on that item | ✅ | ✅ | Users, public link, instructions |
| A6 | Resolve moves the report to Resolved with the note | ✅ | ✅ |  |
| A7 | The nav count matches the open reports and updates after an action | n/a | ✅ | 4, 3, 2, then hidden |

## Content rules and screens

| # | Check | Desktop web | Mobile web | iOS | How confirmed |
|---|---|---|---|---|---|
| S1 | `/content-rules` opens signed out | ✅ | ✅ | n/a |  |
| S2 | The share dialog links to the content rules | ✅ | ✅ | ✅ |  |
| S3 | The report dialog links to the content rules | ✅ | ✅ | ✅ |  |
| S4 | Screens match the mockups, light and dark | ✅ | ✅ | ✅ | Screenshots in `screenshots/`. Differences are listed below |
| S5 | "Shared by" shows on a shared conversation and not on your own | ✅ | ✅ | ✅ |  |
