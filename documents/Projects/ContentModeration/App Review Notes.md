# App Review notes

Apple paused the review of 1.0 with "Guideline 2.1 - Information Needed" and asked for a screen recording plus answers to six questions in the Notes field. This page has the text to paste and what to do around it. It assumes the content moderation release (Report, Block, filter) is live in production.

## Before submitting

- [ ] Merge the moderation release to `main`, and install the TestFlight build it produces on your iPhone. TestFlight builds use production.
- [ ] Demo account on production: an email and password account, with an AI provider key that has a spending cap. Add Zilliz, Voyage and Tavily keys so memory, search and web search work. Put its email and password in App Review Information > Sign-In Information, not in the Notes.
- [ ] A second account shares one instruction and one conversation with the demo account. Searching by username only finds Discoverable accounts, so turn on Discoverable in the demo account first (Settings > Profile). Copy the conversation's link for the Notes and for the recording.
- [ ] Record the video (script below).
- [ ] After recording, unblock the second account in the demo account and share both items again. Blocking removed the shares, and the reviewer needs them to try Report and Block.
- [ ] Fill in `[VERSION]`, `[INSTRUCTION NAME]` and `[CONVERSATION LINK]` below, paste the text into App Review Information > Notes, and attach the video. If the video is too large to attach, upload it somewhere unlisted and put its link at the top of the Notes.
- [ ] On the app's page: Support URL `https://genflowly.com/support`, Privacy Policy URL `https://genflowly.com/privacy-policy`.
- [ ] Submit for review.

## Why the recording

Apple asked for it in the rejection, as item 1 of the next steps, and the review stays paused until it arrives. Their wording: a recording "captured on a physical device, running the latest operating system", which "must begin with launching the app and show the typical user flow", including "account registration, login, and account deletion flows" and, because people can share content with each other, "the required content reporting and blocking mechanisms". Report and Block only appear on something another account shared with you, which is why the recording needs the second account and the moderation build.

## Recording script

On the iPhone, updated to the latest iOS, start Screen Recording from Control Center.

1. Start on the home screen and tap the app icon.
2. Sign up with a throwaway email address.
3. On the permission screen, tap Agree and continue.
4. In the setup wizard, tap Skip setup.
5. Delete that account: Settings > Profile > Delete your data > Delete account, type DELETE, confirm.
6. Sign in with the demo account.
7. Send a message, switch the model and ask again, attach a photo, then open History, a project, Memory, Instructions and Agents.
8. Instructions > the shared instruction > top-right menu > Report instruction. Pick a reason, add a note, send.
9. Open the shared conversation from its link (for example, pasted in Notes). Show the "Shared by" label, then top-right menu > Report conversation, send, and tap Block on the confirmation.
10. Settings > Profile > Blocked users: show the second account, then tap Unblock.

## Notes text

Paste into App Review Information > Notes. It is 3,853 characters before the placeholders are filled; the field allows 4,000.

```
1. SCREEN RECORDING
Attached, recorded on an iPhone running iOS [VERSION]. It starts at launch and shows sign-up, the AI data permission screen, the setup wizard, account deletion, sign-in with the demo account, a chat, memory, projects, instructions and agents, then an instruction and a conversation shared by a second account, with Report, Block and Unblock.

2. PURPOSE AND AUDIENCE
Unbiase AI lets people use several AI models (OpenAI, Anthropic Claude, Google Gemini, xAI Grok and others) in one app, with their own API keys from those providers. Users can ask several models the same question and compare the answers. Conversations, projects, reusable instructions, agents and memory (facts learned from conversations, which users can view, edit, switch off or delete) work across all providers.
Audience: professionals, developers, students and researchers who use more than one AI provider.
Value: instead of switching between separate apps and subscriptions and losing context, they keep everything in one place and pay the providers directly. The app is free, with no ads, in-app purchases or subscriptions.

3. SETUP AND ACCESS
Sign in with the demo account in Sign-In Information. It already has working API keys, so no setup is needed.
- Chat: type a message and send. Use the model picker to switch provider or model and ask again.
- Menu (top-left button): Projects, History, Memory, Instructions, Agents, Settings.
- Settings > Profile > Delete your data: Delete all keys, or Delete account (type DELETE to confirm).
New users sign up with email and password, Sign in with Apple, Google or GitHub. Before anything reaches an AI service, the app asks permission. A setup wizard then asks for an AI provider key; it can be skipped.

4. EXTERNAL SERVICES
- Auth0: sign-in
- AI providers, on the user's own API key: OpenAI, Anthropic, Google Gemini, xAI and others the user adds
- Zilliz Cloud (vector database) and Voyage AI (embeddings): memory and search, on the user's own accounts
- Tavily: web search, on the user's own key
- Amazon Web Services, Fly.io, Cloudflare: hosting. Grafana Labs: service monitoring
No payment processor is used.

5. REGIONS
The app works the same in all regions and is in English. Each AI provider's own rules decide where it can be used.

6. REGULATION AND THIRD-PARTY MATERIAL
The app is not in a regulated industry and gives no medical, legal or financial services. It contains no licensed third-party material. AI answers come from the providers under each user's own agreement with them.

USER-GENERATED CONTENT
Conversations and instructions are private until their owner shares them with specific users or as a public link, view-only or editable. A user can be found by username only after turning on Discoverable in Settings > Profile, which is off by default.
- Filter: before shared content reaches anyone (sharing, making public, saving a shared instruction, or an editor adding to a shared conversation), our server checks it against a list of objectionable terms and refuses it on a match.
- Report: anyone an item is shared with can report it from the item's menu (top-right button), with a reason. Reports reach our support team by email and in our moderation tool. We review them promptly and make offending items private.
- Block: from the item's menu, the share dialog, or Settings > Profile > Blocked users. Blocking removes all shares between the two users, and neither can then find or share with the other.
- Content rules: linked when sharing, and at https://genflowly.com/content-rules
- Contact: https://genflowly.com/support, also in Settings > Support.
To try it, open Menu > Instructions > "[INSTRUCTION NAME]" in the demo account. A second account shared it, and its top-right menu has Report and Block. A shared conversation opens in the app from this link: [CONVERSATION LINK]
```
