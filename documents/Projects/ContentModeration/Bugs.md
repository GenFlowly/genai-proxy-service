# Bugs: Content moderation for shared items

Severity: High, Medium, Low. Status: Open, Fixed (verified live), Won't fix. Side: Backend, Web, Admin, iOS, Both.

| ID | Severity | Status | Side | Bug |
|---|---|---|---|---|
| [CM-001](#cm-001) | Medium | Fixed (verified: CI build passes) | Web | The production build failed on two link warnings |
| [CM-002](#cm-002) | Low | Fixed (verified live) | iOS | The "Shared by" pill covered the first item of the open menu |
| [CM-003](#cm-003) | Low | Fixed (verified live) | Web | Share dialog row menu: items centered, and the ⋯ turned red |
| [CM-004](#cm-004) | Low | Fixed (verified live) | Both | Report reasons showed bright white radios in dark mode |
| [CM-005](#cm-005) | Low | Fixed (verified live) | Web | Content rules: the rules card sat under the text on desktop |
| [CM-006](#cm-006) | Low | Fixed (verified live) | Admin | Reports table cut off its last columns at 1280px |
| [CM-007](#cm-007) | Low | Open | Web | On phones, Block isn't red in the header menu |
| [CM-008](#cm-008) | Medium | Open (read from code, not run) | Backend | Only the first 1 MB of a conversation's messages is read |
| [CM-009](#cm-009) | Low | Open | Backend | Instruction share routes answer 500 instead of 403 |
| [CM-010](#cm-010) | Low | Open | Web | "New Chat" wraps to two lines next to Share at 1280px |
| [CM-011](#cm-011) | Low | Open | Both | "Remove from my list" names a list conversations aren't in |
| [CM-012](#cm-012) | Low | Open | Backend | Voice turns and renames by editors skip the filter |

## CM-001

**The production build failed on two link warnings**

- **Actual:** the links passed to translated text were empty anchors, which the linter warns about. `CI=true` turns warnings into errors, so the pre-commit hook and deploy would have failed.
- **Fix:** a small `ContentRulesLink` component holds the anchor. The CI build now passes.

## CM-002

**The "Shared by" pill covered the first item of the open menu**

- **Steps:** on iOS open a conversation shared with you, tap ⋯.
- **Actual:** "New Chat" was hidden behind the pill. Confirmed in a simulator screenshot.
- **Fix:** the pill now sits behind the header. Verified light and dark.

## CM-003

**Share dialog row menu: items centered, and the ⋯ turned red**

- **Actual:** the row's existing button styles applied to the new menu. Confirmed in screenshots at both widths.
- **Fix:** the menu has its own alignment and hover colors.

## CM-004

**Report reasons showed bright white radios in dark mode**

- **Actual:** the browser's default radio and the app's copy of it stay white in dark mode, unlike the approved design.
- **Fix:** both now draw the design's radio from theme colors.

## CM-005

**Content rules: the rules card sat under the text on desktop**

- **Actual:** the page is narrower than the grid's large breakpoint, so the two columns never appeared.
- **Fix:** the columns start at the medium breakpoint.

## CM-006

**Reports table cut off its last columns at 1280px**

- **Actual:** Received was hidden behind a sideways scroll, and Resolve wrapped to a second line.
- **Fix:** tighter cells, a date-only Received column and smaller action buttons.

## CM-007

**On phones, Block isn't red in the header menu**

- **Actual:** the component library's phone menu item has no danger style, so Block looks like the other items. The approved design shows it in red. Desktop and iOS are red.
- **Needs:** a `danger` option on `MobileHeaderMenuItem` in the component library, which is a separate release.

## CM-008

**Only the first 1 MB of a conversation's messages is read**

- **Where:** `ConversationRepository.getMessagesForConversation` runs one DynamoDB query and doesn't follow `LastEvaluatedKey`. It existed before this work.
- **Effect:** the share filter and report snapshot can miss the end of a very long conversation. Conversation history uses the same call, so it is likely affected too.
- **Confirmed:** read from the code only. No conversation that long was tested.

## CM-009

**Instruction share routes answer 500 instead of 403**

- **Steps:** as someone without edit rights, remove another person from an instruction's shares.
- **Actual:** 500, because the route doesn't map the permission error. The request is still refused. Seen in the API run. It existed before this work.

## CM-010

**"New Chat" wraps to two lines next to Share at 1280px**

- **Steps:** open your own conversation on desktop at 1280px wide.
- **Actual:** the button label wraps. Nothing added here renders for an owner, so it existed before this work.

## CM-011

**"Remove from my list" names a list conversations aren't in**

- **Actual:** shared conversations aren't listed in History, so the action really means "leave this conversation". It works correctly. The wording matches the approved design, so this is the user's call.

## CM-012

**Voice turns and renames by editors skip the filter**

- **Actual:** the filter covers typed posts by editors. A voice session in a shared conversation and a title rename by an editor aren't checked. Report still covers both. Read from the code.
