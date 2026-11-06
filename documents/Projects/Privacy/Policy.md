> [!warning] DRAFT: do not publish yet
> This draft describes the app **after the P0 fixes in [Recommendations.md](Recommendations.md)**. Sentences marked ⛔ are **not true today**. Before publishing, clear each one using Appendix A, which also gives accurate wording to use if you need to publish before a fix ships.
>
> Delete this notice, all ⛔ markers and both appendices before publishing. Text in `[BRACKETS]` needs your input. Have a lawyer review the final text.

# Privacy Policy

**Effective date:** `[DATE]`
**Last updated:** `[DATE]`

Unbiase AI ("Unbiase AI", "we", "us") is operated by `[LEGAL ENTITY]`, `[ADDRESS]`. This policy explains what we collect when you use our web app at genflowly.com, our iOS app and our developer API, where that information goes, and the choices you have.

## The short version

- **We don't sell your data, show ads, or use your content to train AI models.**
- **There are no analytics or advertising trackers in our apps.**
- **Your content goes where you send it.** Messages go to the AI providers you choose. Background features such as titles and memory use your primary provider, the one you rank first in Settings. Other services only receive your content if you connect them. Memory is on by default, and you can turn it off in Settings. ⛔R7 ⛔R8 ⛔R9
- **You stay in control.** You can delete your conversations, notes, memories, API keys and account at any time. ⛔R3 ⛔R4 ⛔R5
- **Your content is encrypted in transit and at rest, but it is not end-to-end encrypted.** Our servers process it to run the app.

## Which section applies to you

Unbiase AI has two modes. **Section 1** covers Bring Your Own Key, **Section 2** covers Paid mode, and **"Terms for both modes"** applies to everyone.

| | **Bring Your Own Key (BYOK)** | **Paid mode** (not yet available) |
|---|---|---|
| **Whose AI accounts are used** | Yours, with keys you provide | Ours |
| **Who pays the AI providers** | You pay them directly | You pay us |
| **Who the providers have a contract with** | You | Us |
| **Where search indexes are stored** | A vector database you connect | A database we operate |
| **Our access to your provider accounts** | We use your keys only as this policy describes | Not applicable |

---

## Section 1: Bring Your Own Key (BYOK)

BYOK is the most private way to use Unbiase AI. You choose every provider that receives your content, under your own contracts with them.

### 1.1 How BYOK works

You give us API keys for the services you want to use. We use those keys to send your requests to those services and return the results. We never run your requests on our own provider keys, and we never fall back to a shared key, shared vector database or shared search account. If you haven't connected a service, the features that need it simply don't work.

Your relationship with each provider is your own. Its terms and privacy policy apply to whatever it receives, and we don't control what it does with that data.

### 1.2 Where your content goes

| When you... | What is sent | Where it goes |
|---|---|---|
| **Send a chat message** | Your message, earlier messages in that conversation, your instruction, attachments, and any memories or notes used for that reply | The AI provider or providers you selected, using your key |
| **Change provider in a conversation** | The same, including earlier messages and attachments | The newly selected provider |
| **Start a chat or save an untitled note** | The first message, or up to the first 4,000 characters of the note, to create a title | Your primary provider: the one ranked priority 1 in Settings, or the first one you added if you haven't ranked any ⛔R9 |
| **Create or use an instruction** | The instruction's text, to suggest an icon and category | Your primary provider ⛔R9 |
| **Use memory** (on by default, with separate switches for learning from chats, learning from notes, and using what it learned ⛔R7) | Excerpts from chats and notes, and your existing memories, to learn and update facts about you. Each memory, and each message you send while memory is on, is also sent for lookup. | Your primary provider, your embedding provider and your vector database. Memories used in a reply go to the provider you chat with. |
| **Turn on indexing** (off by default ⛔R8) | Your chats and notes | Your embedding provider and your vector database, where the text is stored in readable form |
| **Search your content** | Your search words | Your embedding provider and your vector database |
| **Use an assistant that can search the web**, if you connected a search key | Search terms written by the AI, which may reflect your conversation | Your web search provider (currently Tavily) |
| **Connect your own tool, MCP server or API** | Inputs the AI writes for that tool, which may reflect your conversation | The service you connected |
| **Use voice through the API** | Your audio and conversation context. Transcripts are saved as messages. | OpenAI or Google, using your key |
| **Add or save a key** | One small test request. Embedding keys also get a one-character test about once a week to check which models they can use. | That provider |

If you haven't connected an embedding provider and a vector database, your chats and notes are not sent to our indexing system at all. ⛔R6

When a provider offers a per-request option not to store your content, we use it. ⛔R10

### 1.3 Your API keys

- **Storage.** Your keys are encrypted with AWS Key Management Service before they are stored.
- **Use.** They are decrypted only in server memory, to make the requests described in section 1.2.
- **Visibility.** We never show a stored key again after you save it, and we don't share it with anyone except the provider it belongs to.
- **Removal.** You can remove any key at any time in Settings. ⛔R5 Removing a key doesn't delete anything that provider already holds.

### 1.4 What your providers do with your content

Provider practices differ, and some of the defaults may surprise you. **Please check the terms of each provider you connect**, especially whether it uses your content for training, how long it keeps it, and where it stores it. We show key facts when you add a key. ⛔R11

As of `[DATE]`, for example:

- **Voyage AI**'s terms allow it to use your content to train its models **unless you opt out**. Opting out requires a payment method on file and isn't retroactive.
- **Google** may use content from the **free tier** of the Gemini API to improve its products, and human reviewers may read it. This doesn't apply to the paid tier, or to use in the EEA, Switzerland or the UK.
- **Tavily** has an account setting that controls whether your search queries may be stored and used.
- **DeepSeek** states that it stores personal data in the People's Republic of China.

These terms can change, and the providers' own documents take precedence over this summary.

| Provider | Privacy information |
|---|---|
| OpenAI | [Privacy policy](https://openai.com/policies/privacy-policy/), [API data controls](https://developers.openai.com/api/docs/guides/your-data) |
| Anthropic | [Privacy policy](https://www.anthropic.com/legal/privacy), [Commercial terms](https://www.anthropic.com/legal/commercial-terms) |
| Google Gemini | [Gemini API terms](https://ai.google.dev/gemini-api/terms) |
| Voyage AI | [Privacy policy](https://www.voyageai.com/privacy), [Terms](https://www.voyageai.com/tos) |
| Zilliz Cloud | [Privacy policy](https://zilliz.com/privacy-policy) |
| Tavily | [Privacy policy](https://tavily.com/privacy) |
| xAI | [Privacy policy](https://x.ai/legal/privacy-policy) |
| Mistral | [Privacy policy](https://legal.mistral.ai/terms/privacy-policy) |
| Groq | [Privacy policy](https://groq.com/privacy-policy) |
| DeepSeek | [Privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) |
| Cohere | [Privacy policy](https://cohere.com/privacy) |
| Perplexity | [Privacy policy](https://www.perplexity.ai/hub/legal/privacy-policy) |
| Together AI | [Privacy policy](https://www.together.ai/privacy) |
| Fireworks AI | [Privacy policy](https://fireworks.ai/privacy-policy) |
| NVIDIA | [Privacy policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/) |

You can also connect other providers through our catalog. The same principle applies: their own terms govern what they receive.

### 1.5 What we keep in BYOK mode

We store your conversations, notes, memories and attachments on our servers so you can reach them from any device. "How long we keep your data" explains how long, and how to delete them.

Your search index lives in **your** vector database, not ours. When you delete something, we also ask your vector database to delete it, as long as your connection details still work. If you have already removed them, or they have stopped working, you will need to delete that data from your vector database yourself.

### 1.6 Our commitments in BYOK mode

1. We send your content only to services you have connected, for the purposes described above.
2. Memory is on by default. You can turn off learning from chats, learning from notes, and using what it learned, each on its own. Other features that send your content to extra services are off until you turn them on. ⛔R7 ⛔R8
3. Background tasks run only on your primary provider. If it fails, they don't move to another provider. ⛔R9
4. We don't use our own provider accounts for your requests.
5. We don't use your content to train AI models, and we don't sell it.

---

## Section 2: Paid mode

> [!note] Paid mode is not available yet
> This section describes how Paid mode will work. It takes effect only when Paid mode launches, and we will update it first with the actual provider list. ⛔M1-M10

### 2.1 How Paid mode differs

In Paid mode you don't need your own provider accounts. We hold the contracts and API keys, and you pay us. This means **we choose the providers**, and they process your content on our behalf.

### 2.2 Where your content goes

Your content follows the same paths as in section 1.2, except that the services are ones we've chosen and they run under our accounts:

| Purpose | Provider | Receives |
|---|---|---|
| AI responses | `[PROVIDER LIST]` | Your messages, history, instructions, attachments, and memories or notes used for that reply |
| Search indexing and embeddings | `[PROVIDER]` | Text from chats and notes you choose to index, and your search words |
| Vector database | `[PROVIDER]` | Indexed text and related data, kept in a database shared between customers and separated by account |
| Web search | `[PROVIDER]` | Search terms written by the AI |
| Payments | `[PAYMENT PROCESSOR]` | Your name, email, billing details and payment method |

### 2.3 Our commitments on providers

We use a provider in Paid mode only if it agrees in writing:

- **not to use your content to train its models,**
- **to process your content only to provide the service,** and
- **to delete it within `[X]` days**, or to keep nothing where zero retention is available.

Providers may keep some data for a limited time to detect abuse, as their terms allow. We list each provider and its retention period at `[SUB-PROCESSOR PAGE]`, and we'll give `[30]` days' notice before adding one. We can't guarantee that deleting your data from our systems also removes what a provider holds during that period.

### 2.4 Payment information

Our payment processor handles your card details, and we don't store them. We keep billing records and usage totals (such as token counts and amounts charged) for as long as tax and accounting laws require, currently `[X]` years, even after you delete your account. These records don't contain your conversations.

### 2.5 Abuse prevention

Because requests run under our accounts, we are responsible for how the service is used. `[DESCRIBE AUTOMATED CHECKS, WHEN FLAGGED CONTENT MAY BE REVIEWED AND BY WHOM, AND HOW LONG IT IS KEPT]`

### 2.6 Switching between modes

- **BYOK to Paid.** We won't copy data from your own vector database. Anything you want searchable in Paid mode is indexed again only after you agree.
- **Paid to BYOK.** We'll offer to delete your data from the vector database we operate.
- **No silent mixing.** If a BYOK key is missing, your request fails. It never falls back to our accounts.

---

## Terms for both modes

### What we collect

| Category | Examples | Where it comes from |
|---|---|---|
| **Account** | Sign-in identifier, email, name, profile picture link, username, whether you're discoverable | Your sign-in provider and you |
| **Content** | Messages, AI replies, instructions, agents, projects, notes, attachments, generated files, memories, tool results, and traces of the AI's reasoning and tool use | You and the AI services you use |
| **Credentials** | Provider, vector database and tool keys (encrypted), and developer API keys | You |
| **Settings** | Model choices and feature preferences | You |
| **Usage** | Token counts, estimated costs, and counts of searches and database operations, grouped by day | Generated as you use the app |
| **Technical** | Request IDs, error messages and timestamps | Generated automatically |
| **Payment** (Paid mode only) | Billing details, handled by our payment processor | You |

Our application doesn't store your IP address. The infrastructure providers listed below process it to deliver the service and may keep it in their own logs.

We don't ask you to provide sensitive information. If you include it in your content, it is handled like the rest of your content and sent to the services described in this policy, so please consider this before sharing it.

### How we use it

| Purpose | Legal basis (where applicable) |
|---|---|
| Provide the app: run your requests, store and show your content, keep you signed in | Performance of our contract with you |
| Memory, which is on by default | Our legitimate interest in personalizing your replies. You can object by turning it off in Settings ⛔R7 |
| Provide optional features you turn on, such as indexing and web search | Your consent, which you can withdraw in Settings ⛔R8 |
| Keep the service secure and reliable: fix errors, prevent abuse, monitor performance | Our legitimate interest in running a secure service |
| Show you your usage and costs, and bill you in Paid mode | Performance of our contract |
| Meet legal obligations | Legal obligation |

### What we don't do

- We don't sell or rent your personal information, or share it for advertising.
- We don't use your content to train AI models.
- We don't show ads.
- We don't use analytics or advertising trackers in our apps.
- We don't write your messages or notes to our logs. Our logs contain identifiers and error information. ⛔R1 ⛔R19

### Companies that help us run the app

| Company | What it does | What it handles |
|---|---|---|
| **Amazon Web Services** (United States) | Database, file storage, key encryption, background processing | Your account data and content, encrypted at rest |
| **Fly.io** (United States) | Runs our servers | Your content and keys in memory while processing requests |
| **Cloudflare** (global network) | Website hosting and delivery, security, routing of web app requests | Web app traffic, including your content in transit, and your IP address |
| **Auth0 by Okta** (United States) | Sign-in | Your sign-in details, email, name, picture, and login records |
| **Grafana Labs** | Service health dashboards and alerts | Performance metrics, which contain no content ⛔R1 |
| **Apple** | iOS app distribution | As described in Apple's own terms. We don't send it your content. |

We require these companies to protect your information to at least the standard in this policy. ⛔Q10 We may also disclose information if the law requires it, to protect people's rights and safety, or as part of a merger or sale of our business, in which case this policy continues to apply unless we notify you otherwise.

### Sharing you choose

- **Public links.** Anyone with the link can read the conversation's messages and replies, without signing in. It doesn't reveal your notes, memories or the AI's internal reasoning and tool activity, and your name is hidden unless you choose to show it. ⛔R2 Search engines are asked not to index these pages. ⛔R2 Anything you share publicly may be copied by others. If you allow editing on a public link, anyone signed in who has the link can add to the conversation.
- **Sharing with specific people.** They can see the conversation, including prompts you wrote and replies you received.
- **Continuing a shared conversation.** When someone with edit access continues a conversation, its history is sent to the AI provider they use, under their own account.
- **Forks.** Someone with access to a conversation can copy it into their own account. **That copy remains theirs, even if you later delete the original or stop sharing it.**
- **Instructions and agents.** The ones you share become visible to the people you share them with.
- **Being discoverable.** This is off by default. If you turn it on, other users can find your username, name and picture when sharing.
- **Connected tools and services.** Anything you connect receives what section 1.2 describes.

Deleting or archiving a conversation ends its public link and its shares.

### How long we keep your data

| Data | How long |
|---|---|
| **Conversations, notes, attachments and generated files** | Until you delete them or your account. ⛔R3 |
| **Deleted items** | Erased from our active systems when you delete them. Copies in backups expire within 35 days. ⛔R3 |
| **Memories** | Until you delete them or your account. |
| **Temporary files used by AI tools** | 7 days. ⛔R18 |
| **API keys and connection details** | Until you remove them or delete your account. ⛔R5 |
| **Account details** | Until you delete your account. ⛔R4 |
| **Backups** | Deleted data can remain in encrypted backups for up to 35 more days, then it is gone. ⛔R17 |
| **Operational logs** (no content) | 30 days. ⛔R18 |
| **Usage totals** | For the life of your account. In Paid mode, billing records are kept as section 2.4 describes. |
| **Copies on your device** | Until you sign out. |
| **Providers you use** | Set by each provider's own terms. We can't delete what they hold. |

### Security

- Connections to our apps and to outside providers are encrypted in transit. Our internal services communicate over a private network.
- Data in our databases and file storage is encrypted at rest.
- API keys receive an extra layer of encryption with AWS Key Management Service.
- Stored files are private, and access links expire within an hour.

No system is perfectly secure. If a breach affects your information, we'll notify you and the relevant authorities as the law requires.

### Who at Unbiase AI can see your content

Our systems process your content automatically, and it is not end-to-end encrypted, so authorized staff have the technical ability to access it. We access it only when necessary to fix a problem you report or that affects the service, to protect security, or to comply with the law. Access is limited to people who need it and is logged. ⛔R16 ⛔Q6

### Your rights and choices

**In the app, at any time:**

| You can... | Where |
|---|---|
| See your profile and change your username | Settings |
| Delete a conversation or note | The item's menu ⛔R3 |
| Delete one learned fact, delete them all, or turn memory off | The facts listed under a reply, and Settings > Defaults > Learned facts ⛔R7 |
| Turn indexing off and remove indexed data | Settings ⛔R8 |
| Remove all your API keys | Settings > Profile ⛔R5 |
| Stop sharing a conversation | Share menu |
| Export your data | Settings ⛔R4 |
| Delete your account | Settings > Profile ⛔R4 |

**By law.** Depending on where you live, you may have the right to access, correct, delete, or receive a copy of your personal information, to restrict or object to how we use it, and to withdraw consent. To use these rights, contact `[PRIVACY EMAIL]`. We'll respond within 30 days, and we won't treat you differently for using them. If you're unhappy with our response, you can complain to your local data protection authority.

**California residents.** We don't sell personal information or share it for cross-context behavioral advertising. The categories we collect and use are described above. You have the right to know, delete and correct your information, and to appoint an authorized agent to do so.

`[ADD OTHER REGIONS AS NEEDED, SUCH AS AN EU OR UK REPRESENTATIVE OR INDIA'S DPDP ACT, ONCE TARGET MARKETS ARE CONFIRMED]`

### International transfers

We're based in `[COUNTRY]`, and our main systems are in the United States (AWS and Fly.io in the Virginia region). Cloudflare operates a global network. In BYOK mode your content also goes wherever your chosen providers and vector database are located. Where the law requires it, we use appropriate safeguards for transfers, such as Standard Contractual Clauses. `[CONFIRM]`

### Children

Unbiase AI isn't intended for anyone under `[13, OR 16 IN THE EEA AND UK]`. Some AI providers set a higher minimum age. If you believe a child has given us personal information, contact us and we'll delete it.

### Cookies and local storage

We don't use advertising or analytics cookies.

- **Sign-in.** Auth0 uses cookies to keep you signed in.
- **Security.** Cloudflare may use cookies and a small script to detect automated traffic.
- **Your browser's local storage.** The web app stores sign-in tokens, saved note content, conversation titles, instructions, drafts and display preferences so that the app loads quickly. Signing out clears everything except your theme choice. Please sign out on shared devices.

### Mobile app

The iOS app stores conversation history, notes, instructions and drafts on your device so that they open quickly, and keeps sign-in tokens in the iOS Keychain. Signing out clears this data, apart from your theme choice. The camera is used only if you take a photo to attach. The app doesn't track you across other companies' apps or websites.

Before your content is first sent to a third-party AI provider, the app asks for your permission and tells you which provider will receive it. ⛔R12

### Changes to this policy

We'll post any change here and update the date above. If a change materially affects how we use your information, we'll notify you in the app or by email before it takes effect.

### Contact

`[LEGAL ENTITY]`, `[ADDRESS]`
Email: `[PRIVACY EMAIL]`

---

## Appendix A: Publication gate

**Delete before publishing.** Each row is a promise in the draft that the code doesn't keep today, as of 2026-11-05. To clear a row, ship the fix and verify it. To publish before a fix, replace the promise with the interim wording, which is accurate today.

| Marker | The draft promises | Today | Interim wording if publishing first |
|---|---|---|---|
| ⛔R1 | No content in logs | Step Functions logs and history, and the dead-letter queue, hold full text. **Fixed in PR #331, not yet in production.** Once it deploys, only history from earlier runs holds text, for up to 90 days. The Grafana role still needs narrowing. | "To index your content, our background system temporarily holds its full text, including in workflow history for up to 90 days and in failure queues for up to 14 days." Also narrow the Grafana role, or disclose that Grafana Labs can access these logs. |
| ⛔R2 | Public links reveal only messages and replies | Trace data can reveal note and memory text, and your name and picture are shown | "A public link can also reveal the AI's activity trace, which may include text from your notes, as well as your name and picture." **Fix this rather than publish that sentence.** |
| ⛔R3 | Permanent deletion, everywhere | Archive only. Content is kept indefinitely and can still be used in later AI replies. **Fixed on `development`, not yet in production**: delete is permanent, with no Trash. | "You can archive conversations and notes, which hides them. Archived content stays on our servers and may still be retrieved for later replies. To request deletion, contact `[PRIVACY EMAIL]`." You would need to fulfil those requests by hand. |
| ⛔R4 | Self-service export and account deletion | Deletion is built on `development` for the web app, not yet in production. Export doesn't exist. **Apple requires in-app deletion, so the iOS app still blocks its release.** The Auth0 login is deleted only once Management API credentials are configured. | "To delete your account or get a copy of your data, contact `[PRIVACY EMAIL]`." |
| ⛔R5 | Remove any key | "Delete all keys" is built on `development`, not yet in production. A single key still can't be removed. | "You can replace a stored key, or revoke it with the provider. To remove it from our systems, contact `[PRIVACY EMAIL]`." |
| ⛔R6 | Nothing is indexed without an embedding provider and vector database | Text enters the pipeline anyway | Delete the sentence, and rely on the R1 interim wording. |
| ⛔R7 | Memory on by default, with three switches and "Delete all" | On by default, no switch. **Fixed on development, not yet in production.** | "Memory is on by default. It sends excerpts of your chats and notes to an AI provider and your embedding provider. To turn it off, contact `[PRIVACY EMAIL]`." |
| ⛔R8 | Indexing off by default, with a switch | Always attempted | "If you connect an embedding provider and a vector database, your chats and notes are indexed automatically. There is no setting to turn this off yet." |
| ⛔R9 | Background tasks run only on your primary provider | They prefer OpenAI, then any stored key. **Fixed on development, not yet in production.** | "Background tasks such as titles and memory may use any provider you've added a key for, even if it isn't the one you chose for that chat." |
| ⛔R10 | We use "don't store" options | `store` not set for OpenAI | Delete the sentence. |
| ⛔R11 | Key facts shown when adding a key | Not shown | Delete the sentence. **Keep the Voyage, Google, Tavily and DeepSeek examples.** |
| ⛔R12 | Permission requested before first use | No consent step. **Apple requires this.** | Remove the sentence. Blocks the iOS release. |
| ⛔R16 | Staff access is logged | No CloudTrail trail | Delete "and is logged". |
| ⛔R17 | Backups last up to 35 days | True where backups are on. Core tables have them off. | Accurate as a maximum, but fix the drift. |
| ⛔R18 | Scratch files 7 days, logs 30 days | Scratch files are kept forever, and Lambda logs never expire | "Temporary tool files and operational logs are currently kept indefinitely." |
| ⛔R19 | No content in logs (also) | Some error lines could contain fragments | Add: "Rarely, an error message from a provider may include a short fragment of your content." |
| ⛔Q6 | Staff access only for these reasons | Needs your confirmation | Edit to match actual practice. |
| ⛔Q10 | Third parties protect data to the same standard | Needs confirmation that DPAs are in place. Apple asks for this statement. | Sign the DPAs. Most are self-serve. |
| ⛔M1-M10 | All of Section 2 | Paid mode doesn't exist | Omit Section 2, or publish it marked "coming soon" and keep the notice. |

### Check before publishing

- **Supabase.** If it's enabled in production, add it to the companies table and to retention. Recommendations.md Q7 explains how to check.
- **Voice.** Remove the row in section 1.2 if you won't offer voice through the API at launch.
- **Vector databases.** Confirm no user's connection points to a cluster you own (Recommendations.md Q9). Otherwise "your vector database" isn't true for that user.
- **iOS crash reporting.** The Sentry package is included but switched off. If you enable it, add Sentry to the companies table.

### Words to avoid

Don't use "end-to-end encrypted", "zero-knowledge", "we can't read your data", "fully private" or "anonymous" anywhere, including marketing, unless the feature really delivers that for the data in question. Today none of them would be true. Regulators treat privacy claims that don't match behaviour as deceptive.

### Optional paragraphs for later

Add these when the features ship (see section 7.1 of Recommendations.md).

- **Auto-delete (B1):** "You can have conversations and notes deleted automatically after 30, 90 or 365 days."
- **Temporary chats (B2):** "Temporary chats aren't saved on our servers, indexed or used for memory. They are still sent to the AI provider you select, and that provider's terms apply."
- **Per-user encryption (B3):** "Your content is encrypted with a key unique to your account. When you delete your account we destroy that key, which makes any remaining copies, including backups, unreadable."
- **Device-only keys (B4):** "You can keep an API key only on your device. It is sent with each request and is not stored on our servers. Background features that need your key won't run."

## Appendix B: Items for legal review

**Delete before publishing.**

1. **Controller and processor roles in BYOK.** The draft treats providers as independent services the user engages directly. Confirm that holds, and confirm the role of Unbiase AI when it relays requests on the user's instruction.
2. **Apple's "same or equal protection" wording** (5.1.1(i)) for third parties. BYOK providers are chosen by the user, but Apple's text doesn't make that distinction.
3. **Naming specific vendor practices in section 1.4.** This is useful for users but needs regular upkeep. Consider moving it to a help page with a link from here.
4. **Provider privacy links.** The OpenAI and xAI privacy pages refused automated checks, so open those two by hand to confirm they work. The rest returned a page when checked on 2026-11-05.
5. **Legal bases, age limits, transfer safeguards and regional rights.** These are placeholders until you confirm the entity and target markets (Recommendations.md Q1).
6. **Paid mode.** Section 2 needs review against real vendor contracts, including the abuse-monitoring text in section 2.5.
7. **Terms of Service.** This policy assumes separate terms will exist. None do today.
8. **Memory is on by default.** The draft relies on legitimate interests for memory, because consent under GDPR must be opt-in. Confirm that basis, or switch memory to opt-in for users in regions where it doesn't hold.
