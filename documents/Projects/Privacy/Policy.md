> [!warning] DRAFT: do not publish yet
> This draft describes the app **after the remaining fixes in [Recommendations.md](Recommendations.md)**. Sentences marked ⛔ are **not true in production today**. Before publishing, clear each one using Appendix A, which also gives accurate wording to use if you need to publish before a fix ships.
>
> Delete this notice, all ⛔ markers and both appendices before publishing. Text in `[BRACKETS]` needs your input. Have a lawyer review the final text.

# Privacy Policy

**Effective date:** `[DATE]`
**Last updated:** `[DATE]`

Unbiase AI ("Unbiase AI", "we", "us") is operated by `[LEGAL ENTITY]`, `[ADDRESS]`. This policy explains what we collect when you use our web app at genflowly.com, our iOS app and our developer API, where that information goes, and the choices you have.

## The short version

- **We don't sell your data, show ads, or use your content to train AI models.**
- **There are no analytics or advertising trackers in our apps.**
- **Where your content goes depends on the mode you use.** With Bring Your Own Key, it goes only to the services you connect, under your own accounts. With Pay-as-you-go, it goes to AI and embedding providers we've chosen. We aim to use zero data retention with each of them, so they don't keep your content after replying, but we can't guarantee it. None of them may train on your content. ⛔M1-M10
- **Memory is on by default, and you control it.** You can see, edit and delete everything it has learned, and turn it off in Settings.
- **You stay in control.** You can delete your conversations, memories, API keys and account at any time.
- **Your content is encrypted in transit and at rest, but it is not end-to-end encrypted.** Our servers process it to run the app.

## Which section applies to you

Unbiase AI has two modes. **Section 1** covers Bring Your Own Key, **Section 2** covers Pay-as-you-go, and **"Terms for both modes"** applies to everyone.

| | **Bring Your Own Key (BYOK)** | **Pay-as-you-go** (not yet available) |
|---|---|---|
| **Whose AI accounts are used** | Yours, with keys you provide | Ours |
| **Who pays the AI providers** | You pay them directly | You pay us for what you use |
| **Who the providers have a contract with** | You | Us |
| **Who sets the providers' data controls** | You, in your own provider accounts | We do: zero data retention where we can get it (best effort), and no training |
| **Where search indexes are stored** | A vector database you connect | A database we operate |
| **Our access to your provider accounts** | We use your keys only as this policy describes | Not applicable |

---

## Section 1: Bring Your Own Key (BYOK)

BYOK is the most private way to use Unbiase AI. You choose every provider that receives your content, under your own contracts with them.

### 1.1 How BYOK works

You give us API keys for the services you want to use. We use those keys to send your requests to those services and return the results. We never run your requests on the provider accounts we use for Pay-as-you-go, and we never fall back to a shared key, shared vector database or shared search account. If you haven't connected a service, the features that need it simply don't work.

Your relationship with each provider is your own. Its terms and privacy policy apply to whatever it receives, and we don't control what it does with that data.

### 1.2 Where your content goes

| When you... | What is sent | Where it goes |
|---|---|---|
| **Send a chat message** | Your message, earlier messages in that conversation, your instruction, attachments, and anything the AI looks up for that reply, such as memories, earlier conversations or notes | The AI provider or providers you selected, using your key |
| **Change provider in a conversation** | The same, including earlier messages and attachments | The newly selected provider |
| **Start a chat** | The first message and the instruction's name, to create a title | Your primary provider: the one ranked priority 1 in Settings, or the first one you added if you haven't ranked any |
| **Create or use an instruction** | The instruction's text, to suggest an icon and category | Your primary provider |
| **Use memory** (on by default, with separate switches for learning from your chats and for using what it learned in replies) | After each reply, the latest messages in the conversation and the memories you already have, to learn new facts about you and update existing ones. Each memory is also indexed so it can be found, and while memory is on, each message you send is used to look up relevant memories. | Learning: your primary provider. Indexing and lookup: your embedding provider and your vector database. Memories used in a reply go to the provider you chat with: core memories in every conversation, others only when relevant, and a project's memories only in that project's conversations. |
| **Turn on indexing** (off by default ⛔R8) | Your chats | Your embedding provider and your vector database, where the text is stored in readable form |
| **Search your content** | Your search words | Your embedding provider and your vector database |
| **Use an assistant that can search the web**, if you connected a search key | Search terms written by the AI, which may reflect your conversation | Your web search provider (currently Tavily) |
| **Connect your own tool, MCP server or API** | Inputs the AI writes for that tool, which may reflect your conversation | The service you connected |
| **Use voice through the API** | Your audio and conversation context. Transcripts are saved as messages. | OpenAI or Google, using your key |
| **Add or save a key** | One small test request. Embedding keys also get a one-character test about once a week to check which models they can use. | That provider |

Unless you've connected a vector database and added an embedding key, nothing is sent for indexing. ⛔R6

When a provider offers a per-request option not to store your content, we use it. ⛔R10

### 1.3 Your API keys

- **Storage.** Your keys are encrypted with AWS Key Management Service before they are stored.
- **Use.** They are decrypted only in server memory, to make the requests described in section 1.2.
- **Visibility.** We never show a stored key again after you save it, and we don't share it with anyone except the provider it belongs to.
- **Removal.** You can delete all your stored keys and connections at once in Settings > Profile > Delete your data. Deleting a key doesn't delete anything that provider already holds, and data already in your vector database stays there.

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

We store your conversations, memories and attachments on our servers so you can reach them from any device. "How long we keep your data" explains how long, and how to delete them.

**Notes from earlier versions.** Earlier versions of the app had a notes editor. Notes saved with it are still stored, and the AI can still find them when it searches your content for a reply. `[HOW TO DELETE THEM]` ⛔N1

Your search index lives in **your** vector database, not ours. When you delete something, we also ask your vector database to delete it, as long as your connection details still work. If you have already removed them, or they have stopped working, you will need to delete that data from your vector database yourself.

### 1.6 Our commitments in BYOK mode

1. We send your content only to services you have connected, for the purposes described above.
2. Memory is on by default. You can turn off learning from your chats, and using what it learned in replies, each on its own. Indexing your chats for search is off until you turn it on. ⛔R8
3. Background tasks run only on your primary provider. If it fails, they don't move to another provider.
4. We don't use our own provider accounts for your requests.
5. We don't use your content to train AI models, and we don't sell it.

---

## Section 2: Pay-as-you-go

> [!note] Pay-as-you-go is not available yet
> This section describes how Pay-as-you-go will work. It takes effect only when Pay-as-you-go launches, and we will update it first with the actual provider list. ⛔M1-M10

### 2.1 How Pay-as-you-go differs

In Pay-as-you-go you don't need your own provider accounts. We hold the contracts and API keys with third-party AI providers: the language models that write replies, and the embedding models that power search and memory. You pay us for what you use. This means **we choose the providers**, and they process your content on our behalf, as our sub-processors.

### 2.2 Where your content goes

Your content follows the same paths as in section 1.2, except that the services are ones we've chosen and they run under our accounts:

| Purpose | Provider | Receives |
|---|---|---|
| AI replies | `[PROVIDER LIST]` | Your messages, history, instructions, attachments, and anything the AI looks up for that reply |
| Titles, memory and other background tasks | `[PROVIDER]` | What section 1.2 describes for these tasks |
| Embeddings, for search and memory | `[PROVIDER]` | Text from chats you index, your memories, your search words, and the messages used to look up memories |
| Vector database | `[PROVIDER]` | Indexed text, memories and related data, kept in a database shared between customers and separated by account |
| Web search | `[PROVIDER]` | Search terms written by the AI |
| Payments | `[PAYMENT PROCESSOR]` | Your name, email, billing details and payment method |

### 2.3 How we limit what providers keep

Every provider we use in Pay-as-you-go must agree in writing to process your content only to provide the service to us. ⛔M9 On top of that:

- **Zero data retention, on a best-effort basis.** We aim to use zero data retention with every provider, so that it doesn't store your prompts or its responses once it has replied. We turn it on wherever a provider makes it available to us. This is not a guarantee: not every provider or feature offers it, a provider can change its terms, and we rely on each provider to keep its own commitment. ⛔M1
- **No training.** None of our providers may use your content to train or improve their models. Where a provider's terms would otherwise allow it, we opt out before sending it any content. We don't use free tiers. ⛔M2 ⛔M3
- **Short retention everywhere else.** Some providers don't offer zero data retention, offer it only for some features, or haven't approved it for us yet. They may keep prompts and responses for up to `[30]` days to detect abuse, and then delete them. ⛔M1
- **Models that need retention are marked.** A few models are only available if the provider keeps content for a period, for example 30 days. We mark these in the model picker, so you can choose another model. ⛔M11
- **Safety and legal exceptions.** Even with zero data retention, a provider may keep content that its automated safety systems flag, and its staff may review it. Some providers keep flagged content for up to two years. Providers may also keep content where the law requires it.

We list each provider at `[SUB-PROCESSOR PAGE]`, with whether zero data retention is on, how long it may keep content, and where it processes it. We'll give `[30]` days' notice before adding one. We can't guarantee that deleting your data from our systems also removes what a provider holds during its retention period.

### 2.4 Payment information

Our payment processor handles your card details, and we don't store them. We keep billing records and usage totals (such as token counts and amounts charged) for as long as tax and accounting laws require, currently `[X]` years, even after you delete your account. These records don't contain your conversations.

### 2.5 Abuse prevention

Because requests run under our accounts, we are responsible for how the service is used. We send providers a pseudonymous identifier for your account, never your name or email. ⛔M6 `[DESCRIBE AUTOMATED CHECKS, WHEN FLAGGED CONTENT MAY BE REVIEWED AND BY WHOM, AND HOW LONG IT IS KEPT]`

### 2.6 Switching between modes

- **BYOK to Pay-as-you-go.** We won't copy data from your own vector database. Anything you want searchable in Pay-as-you-go is indexed again only after you agree.
- **Pay-as-you-go to BYOK.** We'll offer to delete your data from the vector database we operate.
- **No silent mixing.** If a BYOK key is missing, your request fails. It never falls back to our accounts.

---

## Terms for both modes

### What we collect

| Category | Examples | Where it comes from |
|---|---|---|
| **Account** | Sign-in identifier, email, name, profile picture link, username, whether you're discoverable | Your sign-in provider and you |
| **Content** | Messages, AI replies, instructions, agents, projects, attachments, generated files, memories (with their earlier versions, where each was learned, and which replies used it), tool results, traces of the AI's reasoning and tool use, and notes saved in earlier versions of the app | You and the AI services you use |
| **Credentials** | Provider, vector database and tool keys (encrypted), and developer API keys | You |
| **Settings** | Model choices and feature preferences | You |
| **Usage** | Token counts, estimated costs, and counts of searches and database operations, grouped by day | Generated as you use the app |
| **Technical** | Request IDs, error messages and timestamps | Generated automatically |
| **Payment** (Pay-as-you-go only) | Billing details, handled by our payment processor | You |

Our application doesn't store your IP address. The infrastructure providers listed below process it to deliver the service and may keep it in their own logs.

We don't ask you to provide sensitive information. If you include it in your content, it is handled like the rest of your content and sent to the services described in this policy, so please consider this before sharing it.

### How we use it

| Purpose | Legal basis (where applicable) |
|---|---|
| Provide the app: run your requests, store and show your content, keep you signed in | Performance of our contract with you |
| Memory, which is on by default | Our legitimate interest in personalizing your replies. You can object by turning it off in Settings |
| Provide optional features you turn on, such as indexing and web search | Your consent, which you can withdraw in Settings ⛔R8 |
| Keep the service secure and reliable: fix errors, prevent abuse, monitor performance | Our legitimate interest in running a secure service |
| Show you your usage and costs, and bill you in Pay-as-you-go | Performance of our contract |
| Meet legal obligations | Legal obligation |

### What we don't do

- We don't sell or rent your personal information, or share it for advertising.
- We don't use your content to train AI models.
- We don't show ads.
- We don't use analytics or advertising trackers in our apps.
- We don't write your messages, memories or other content to our logs. Our logs contain identifiers and error information. ⛔R1 ⛔R19

### Companies that help us run the app

| Company | What it does | What it handles |
|---|---|---|
| **Amazon Web Services** (United States) | Database, file storage, key encryption, background processing | Your account data and content, encrypted at rest |
| **Fly.io** (United States) | Runs our servers | Your content and keys in memory while processing requests |
| **Cloudflare** (global network) | Website hosting and delivery, security, routing of web app requests | Web app traffic, including your content in transit, and your IP address |
| **Auth0 by Okta** (United States) | Sign-in | Your sign-in details, email, name, picture, and login records |
| **Grafana Labs** | Service health dashboards and alerts | Performance metrics and operational logs, which contain no content ⛔R1 ⛔R19 |
| **Apple** | iOS app distribution | As described in Apple's own terms. We don't send it your content. |

In Pay-as-you-go, the providers in section 2.2 also process your content on our behalf.

We require these companies to protect your information to at least the standard in this policy. ⛔Q10 We may also disclose information if the law requires it, to protect people's rights and safety, or as part of a merger or sale of our business, in which case this policy continues to apply unless we notify you otherwise.

### Sharing you choose

- **Public links.** Anyone with the link can read the conversation's messages and replies, without signing in. It doesn't reveal your notes, memories or the AI's internal reasoning and tool activity, and your name is hidden unless you choose to show it. ⛔R2 Search engines are asked not to index these pages. ⛔R2 Anything you share publicly may be copied by others. If you allow editing on a public link, anyone signed in who has the link can add to the conversation.
- **Sharing with specific people.** They can see the conversation, including prompts you wrote and replies you received.
- **Continuing a shared conversation.** When someone with edit access continues a conversation, its history is sent to the AI provider they use, under their own account, or under ours if they use Pay-as-you-go.
- **Forks.** Someone with access to a conversation can copy it into their own account. **That copy remains theirs, even if you later delete the original or stop sharing it.**
- **Instructions and agents.** The ones you share become visible to the people you share them with.
- **Being discoverable.** This is off by default. If you turn it on, other users can find your username, name and picture when sharing.
- **Connected tools and services.** Anything you connect receives what section 1.2 describes.

Deleting a conversation ends its public link and its shares. If someone shared a conversation with you, deleting it removes only your own access.

### How long we keep your data

| Data | How long |
|---|---|
| **Conversations, attachments and generated files** | Until you delete them or your account. |
| **Notes saved in earlier versions of the app** | Until you delete them or your account. ⛔N1 |
| **Deleted items** | Erased from our active systems shortly after you delete them. Copies in backups expire within 35 days. |
| **Memories** | Until you delete them or your account. A memory keeps its earlier versions and its history until it is deleted. Deleting a conversation doesn't delete the memories learned from it. |
| **Temporary files used by AI tools** | 1 day. ⛔R18 |
| **API keys and connection details** | Until you delete them or your account. |
| **Account details** | Until you delete your account. ⛔R4 |
| **Backups** | Deleted data can remain in encrypted backups for up to 35 more days, then it is gone. ⛔R17 |
| **Operational logs** (no content) | 30 days. ⛔R18 |
| **Usage totals** | For the life of your account. In Pay-as-you-go, billing records are kept as section 2.4 describes. |
| **Copies on your device** | Until you sign out. |
| **Providers you use** | In BYOK, set by each provider's own terms, and we can't delete what they hold. In Pay-as-you-go, as section 2.3 describes. |

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
| Delete a conversation | The conversation's menu |
| See, edit and delete what memory has learned, and see where each fact came from and which replies used it | The Memory page |
| Turn memory off, or delete everything it has learned | Settings > Defaults > Learned facts |
| Delete notes saved in earlier versions of the app | `[WHERE]` ⛔N1 |
| Turn indexing off and remove indexed data | Settings ⛔R8 |
| Delete all your API keys | Settings > Profile > Delete your data |
| Stop sharing a conversation | Share menu |
| Export your data | Settings ⛔R4 |
| Delete your account | Settings > Profile > Delete your data |

**By law.** Depending on where you live, you may have the right to access, correct, delete, or receive a copy of your personal information, to restrict or object to how we use it, and to withdraw consent. To use these rights, contact `[PRIVACY EMAIL]`. We'll respond within 30 days, and we won't treat you differently for using them. If you're unhappy with our response, you can complain to your local data protection authority.

**California residents.** We don't sell personal information or share it for cross-context behavioral advertising. The categories we collect and use are described above. You have the right to know, delete and correct your information, and to appoint an authorized agent to do so.

`[ADD OTHER REGIONS AS NEEDED, SUCH AS AN EU OR UK REPRESENTATIVE OR INDIA'S DPDP ACT, ONCE TARGET MARKETS ARE CONFIRMED]`

### International transfers

We're based in `[COUNTRY]`, and our main systems are in the United States (AWS and Fly.io in the Virginia region). Cloudflare operates a global network. In BYOK mode your content also goes wherever your chosen providers and vector database are located. In Pay-as-you-go, our providers process it in the locations listed at `[SUB-PROCESSOR PAGE]`. Where the law requires it, we use appropriate safeguards for transfers, such as Standard Contractual Clauses. `[CONFIRM]`

### Children

Unbiase AI isn't intended for anyone under `[13, OR 16 IN THE EEA AND UK]`. Some AI providers set a higher minimum age. If you believe a child has given us personal information, contact us and we'll delete it.

### Cookies and local storage

We don't use advertising or analytics cookies.

- **Sign-in.** Auth0 uses cookies to keep you signed in.
- **Security.** Cloudflare may use cookies and a small script to detect automated traffic.
- **Your browser's local storage.** The web app stores sign-in tokens, your memories, conversation titles, instructions, agents and display preferences so that the app loads quickly. Signing out clears everything except your theme choice. Please sign out on shared devices.

### Mobile app

The iOS app stores conversation history, memories, instructions and unsent drafts on your device so that they open quickly, and keeps sign-in tokens in the iOS Keychain. Signing out clears this data, apart from your theme choice. The camera is used only if you take a photo to attach. The app doesn't track you across other companies' apps or websites.

Before your content is first sent to a third-party AI provider, the app asks for your permission and tells you which provider will receive it. ⛔R12

### Changes to this policy

We'll post any change here and update the date above. If a change materially affects how we use your information, we'll notify you in the app or by email before it takes effect.

### Contact

`[LEGAL ENTITY]`, `[ADDRESS]`
Email: `[PRIVACY EMAIL]`

---

## Appendix A: Publication gate

**Delete before publishing.** Each row is a promise in the draft that production doesn't keep yet, as of 2026-11-06. To clear a row, ship the fix and verify it. To publish before a fix, replace the promise with the interim wording, which is accurate today.

| Marker | The draft promises | Today | Interim wording if publishing first |
|---|---|---|---|
| ⛔R1 | No content in logs | **Live since 2026-11-05** (PRs #331 and #332): the pipeline carries only IDs, and production workflow logs record errors without data. The trigger lambda, which strips text from old-format messages, still runs its 2026-10-10 image until the CDK tag fix (`e258f3a3`, merged in PR #337) reaches production, so don't redrive the dead-letter queue before then. Copies made before 2026-11-05 age out: CloudWatch and the dead-letter queue by 2026-11-12, and workflow history by 2027-02-04 unless an AWS support case shortens it. The Grafana role still has `CloudWatchReadOnlyAccess` (checked 2026-11-06). | "Content indexed before 6 November 2026 may remain in our background system's workflow history until 4 February 2027, when it is deleted automatically." After 2026-11-12 that is the only copy left. Also narrow the Grafana role. |
| ⛔R2 | Public links reveal only messages and replies, hide your name, and aren't indexed | Not built (checked 2026-11-06). Trace data can reveal note, memory and past-chat text, your name and picture are shown, and `robots.txt` allows indexing. | "A public link can also reveal the AI's activity trace, which may include text from your notes, memories and earlier conversations, as well as your name and picture." **Fix this rather than publish that sentence.** |
| ⛔R4 | Self-service export, and account deletion that also removes your sign-in | Deletion is live on the web (PR #334, 2026-11-06). The iOS app has it in its uncommitted build, and Apple requires it before release. Export doesn't exist. The Auth0 login survives deletion, because `AUTH0_MGMT_DOMAIN`, `AUTH0_MGMT_CLIENT_ID` and `AUTH0_MGMT_CLIENT_SECRET` aren't set in either GitHub environment (checked 2026-11-06). Check the open items under R3 and R4 in Recommendations.md before clearing this row. | "To get a copy of your data, contact `[PRIVACY EMAIL]`." For the login, adding the three secrets is the whole fix. Until then add: "Your sign-in record with Auth0 is deleted on request." |
| ⛔R6 | Nothing is sent for indexing without both a vector database and an embedding key | In dev since 2026-11-07 (PR #338), not yet in production: flags on each profile gate chats, notes, instructions, memories and search, and the pipeline embeds nothing without a vector database. Live today: only chats are skipped, and only when no vector database is connected (PR #332). | "If you haven't connected a vector database, your chats aren't sent for indexing at all." |
| ⛔R8 | Indexing off by default, with a switch | Built 2026-11-07, not yet deployed: "Index my chats" in Settings > Defaults > Search index, off until the user turns it on, and "Delete indexed chats". Live today: indexing starts on its own once a vector database is connected. | "If you connect a vector database, your chats are indexed automatically. There is no setting to turn this off yet." |
| ⛔R10 | We use "don't store" options | Built 2026-11-07, not yet deployed: every OpenAI call sets `store=False`, and gpt-5 keeps its reasoning encrypted between tool rounds. Live today: OpenAI keeps Responses API state for 30 days. | Delete the sentence. Pay-as-you-go needs this fix too, unless OpenAI approves zero data retention, which forces `store` off. |
| ⛔R11 | Key facts shown when adding a key | Not shown | Delete the sentence. **Keep the Voyage, Google, Tavily and DeepSeek examples.** |
| ⛔R12 | Permission requested before first use | No consent step. **Apple requires this.** | Remove the sentence. Blocks the iOS release. |
| ⛔R16 | Staff access is logged | No CloudTrail trail in production (checked 2026-11-06) | Delete "and is logged". |
| ⛔R17 | Backups last up to 35 days | True where backups are on. Point-in-time backups are still off on `Message`, `Conversation`, `CustomerProfile` and `CustomerVendorApiKeys` (checked 2026-11-06). | Accurate as a maximum, but fix the drift. |
| ⛔R18 | Scratch files 1 day, logs 30 days | Scratch files written since 2026-11-06 expire after 1 day (the bucket rule is live, checked 2026-11-06). Older ones carry no tag, so they stay until deleted once. Lambda log groups never expire (checked 2026-11-06). | "Temporary tool files created before 6 November 2026 and operational logs are currently kept indefinitely." |
| ⛔R19 | No content in logs (also) | Some error lines could contain fragments | Add: "Rarely, an error message from a provider may include a short fragment of your content." |
| ⛔N1 | Old notes can be deleted in the app | Since PR #335 (live 2026-11-06), the web app can't list, open or delete notes, and the iOS app follows in its uncommitted build. Saved notes stay in DynamoDB and the vector database, and `search_knowledge_base` still returns them in replies. Deleting the account still removes them. | "To delete notes you saved in earlier versions of the app, delete your account or contact `[PRIVACY EMAIL]`." To clear it, pick one: delete every note after notice and stop the knowledge search returning notes, or add "Delete all notes" to Settings > Profile > Delete your data. |
| ⛔Q6 | Staff access only for these reasons | Needs your confirmation | Edit to match actual practice. |
| ⛔Q10 | Third parties protect data to the same standard | Needs confirmation that DPAs are in place. Apple asks for this statement. | Sign the DPAs. Most are self-serve. |
| ⛔M1-M10 | All of Section 2 (Recommendations.md calls it Paid mode) | Pay-as-you-go doesn't exist. Before launch, choose the providers, turn on or apply for zero data retention, and set the opt-outs. The next table shows what each provider offers. | Omit Section 2, or publish it marked "coming soon" and keep the notice. |
| ⛔M11 | Models that need retention are marked in the model picker | Not built. Some models can't run under zero data retention (see the next table). | Don't offer those models in Pay-as-you-go, or delete the sentence and name them in section 2.3. |

**Cleared since the first draft**, each checked in production on 2026-11-06:

- **R3 (delete):** Permanent delete of conversations went live with PR #334. Notes are covered by N1 instead.
- **R5 (keys):** "Delete all API keys" went live with PR #334. Removing a single key is still not possible, but the draft no longer promises it.
- **R7 (memory):** The switches went live with PR #332, and PR #335 hid "Learn from notes".
- **R9 (background tasks):** They run on the priority-1 provider only, since PR #332.

### Pay-as-you-go: zero data retention and training, by provider

Checked 2026-11-06 on each provider's own pages, except where marked "secondary". These terms change, so check them again before signing.

| Provider | Training on API content | Zero data retention (ZDR) | Without ZDR | Watch out for |
|---|---|---|---|---|
| **OpenAI** | Off unless you opt in | On request, if OpenAI approves (through sales), per organization or project. Covers Responses, Chat Completions, Embeddings, Realtime and audio, and forces `store` off. | Abuse logs up to 30 days. Responses API state 30 days unless `store=false` (R10). | ZDR doesn't cover Files, Batch, Assistants, vector stores or Conversations. Images and files flagged by its child-safety classifier are kept for review even under ZDR. |
| **Anthropic** | Never without express permission | By arrangement with sales, per organization. Covers the Messages and Token Counting APIs. | The privacy center says content is deleted within 30 days (updated 2026-07-01). The API docs say it isn't kept by default, except for Covered Models. Confirm which applies before quoting a number. | Claude Fable 5 and 5.1 and Claude Mythos 5 and 5.1 require 30-day retention, so they can't run under ZDR (M11). Flagged content is kept up to 2 years and safety scores up to 7 years, whatever the arrangement. |
| **Google Gemini Developer API** (paid tier) | Off on the paid tier. The free tier trains. | No formal ZDR. Google points to Vertex AI for guaranteed ZDR. | Prompts are logged for abuse monitoring for a "limited period". Google's ZDR page gives no length, and secondary sources say 55 days, which exceeds the draft's `[30]`. | Grounding with Google Search or Maps stores data 30 days, and that can't be turned off. Files, explicit caching and the Interactions API store data unless you avoid them or set `store=false`. |
| **Google Vertex AI** | Off | Request an abuse-monitoring exception, and avoid the features that log | Abuse-monitoring logs | Google says some advanced features still log. |
| **Amazon Bedrock** | Off, and model providers can't see prompts or replies | Self-serve: set `data_retention_mode` to `none` per Region, and enforce it with a service control policy | Depends on the model's default. AWS may keep data for abuse detection. | Claude Fable 5 and 5.1 need `aws_review` (AWS keeps content up to 30 days for human review), so they're unavailable under `none`. Keep model invocation logging off. |
| **Mistral** | Separate opt-out setting | On request, at Mistral's discretion, on paid plans, for stateless endpoints including chat and embeddings | 30 days (secondary) | ZDR doesn't cover Labs models, agents, conversations, batch, files or libraries. Turn off Studio Observability. |
| **xAI** | Never without explicit permission | Self-serve: a team admin turns it on in the Console under Team Settings, for every key on the team. Stored Files and Collections must be deleted first. | 30 days, kept for auditing suspected abuse | ZDR switches off the stateful Responses API, Files and Collections, and the Batch API. The default endpoint doesn't guarantee a region: `us.api.x.ai` keeps processing in the US, for some models only, at 10% higher prices. Its docs now name the company SpaceXSI. |
| **Voyage AI** (embeddings) | **On unless you opt out.** Opting out needs an organization admin and a payment method, and it can't be undone in the dashboard. | Opting out gives what Voyage calls "zero-day retention": data is deleted once processed. | Kept, and can be used for training | Opt out on the organization before the first request (M2). |
| **Cohere** (embeddings) | Opt-out flag in the dashboard. The default isn't stated (secondary). | Enterprise customers who make extra usage commitments | Up to 30 days | |
| **Tavily** (web search) | "Allow use of query data" setting. When it's off, queries aren't stored or used. | Not offered separately | | Turn the setting off on our account (M2). |

**Before the first Pay-as-you-go request:**

1. Turn ZDR on where it's self-serve: the xAI Console (Team Settings) and Bedrock (`data_retention_mode: none`). Apply for it with OpenAI, Anthropic, Mistral and Cohere, which grant it on request.
2. Opt out of training wherever it's a setting: Voyage, Cohere, Mistral and Tavily.
3. Use paid tiers only (M3).
4. Set `store=false` on every OpenAI call (R10). Use only the endpoints ZDR covers.
5. On Gemini, don't use grounding with Search or Maps, explicit caching or the Files API, or use Vertex AI with the exception.
6. Record each provider's ZDR status and approval date, its retention without ZDR, and its training status. That record becomes the public sub-processor page.

### Check before publishing

- **Supabase.** If it's enabled in production, add it to the companies table and to retention. Recommendations.md Q7 explains how to check.
- **Voice.** Remove the row in section 1.2 if you won't offer voice through the API at launch.
- **Vector databases.** Confirm no user's connection points to a cluster you own (Recommendations.md Q9). Otherwise "your vector database" isn't true for that user.
- **iOS crash reporting.** The Sentry package is included but switched off. If you enable it, add Sentry to the companies table.
- **Old notes.** Decide N1, then fill in `[HOW TO DELETE THEM]` and `[WHERE]`.

### Words to avoid

Don't use "end-to-end encrypted", "zero-knowledge", "we can't read your data", "fully private" or "anonymous" anywhere, including marketing, unless the feature really delivers that for the data in question. Today none of them would be true. Regulators treat privacy claims that don't match behaviour as deceptive.

Don't say a provider has "zero data retention" unless ZDR is on for our account and covers every feature we use with that provider. Never present it as a guarantee, in the app or in marketing: section 2.3 promises best effort.

### Optional paragraphs for later

Add these when the features ship (see section 7.1 of Recommendations.md).

- **Auto-delete (B1):** "You can have conversations deleted automatically after 30, 90 or 365 days."
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
6. **Pay-as-you-go.** Section 2 needs review against the real vendor contracts and ZDR settings, including the abuse-monitoring text in section 2.5. Each "zero data retention" claim must match an approval or setting that is actually on. Confirm that calling ZDR best effort is clear enough, and that marketing never states it more strongly than section 2.3 does.
7. **Terms of Service.** This policy assumes separate terms will exist. None do today.
8. **Memory is on by default.** The draft relies on legitimate interests for memory, because consent under GDPR must be opt-in. Confirm that basis, or switch memory to opt-in for users in regions where it doesn't hold.
9. **Providers' own use of flagged content.** In Pay-as-you-go, providers act as our processors, but they keep flagged content for their own safety purposes. Confirm whether that makes them independent controllers for that data, and if so, say so in section 2.3.
