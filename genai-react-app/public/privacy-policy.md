# Privacy Policy

**Effective date:** November 7, 2026

**Last updated:** November 26, 2026

Unbiase AI ("Unbiase AI", "we", "us") is operated by Genflowly, based in Seattle, Washington, United States. This policy explains what we collect when you use our web app at genflowly.com, our iOS app and our developer API, where that information goes, and the choices you have.

## The short version

- **We don't sell your data, show ads, or use your content to train AI models.**
- **There are no analytics or advertising trackers in our apps.** The iOS app sends crash and performance reports to Sentry so we can fix bugs. They don't contain your conversations.
- **Where your content goes depends on the mode you use.** With Bring Your Own Key, it goes only to the services you connect, under your own accounts. Pay-as-you-go isn't available yet. When it launches, your content will go to AI and embedding providers we've chosen, under the limits in section 2.
- **Memory is on by default, and you control it.** You can see, edit and delete everything it has learned, and turn it off in Settings.
- **You stay in control.** You can delete your conversations, memories, API keys and account at any time.
- **Your content is encrypted in transit and at rest, but it is not end-to-end encrypted.** Our servers process it to run the app.

## Which section applies to you

Unbiase AI has two modes. **Section 1** covers Bring Your Own Key, **Section 2** covers Pay-as-you-go, and **"Terms for both modes"** applies to everyone.

| | **Bring Your Own Key (BYOK)** | **Pay-as-you-go** (coming soon) |
|---|---|---|
| **Whose AI accounts are used** | Yours, with keys you provide | Ours |
| **Who pays the AI providers** | You pay them directly | You pay us for what you use |
| **Who the providers have a contract with** | You | Us |
| **Who sets the providers' data controls** | You, in your own provider accounts | We do: zero data retention where we can get it (best effort), and no training |
| **Where search indexes are stored** | A vector database you connect | A database we operate |
| **Our access to your provider accounts** | We use your keys only as this policy describes | Not applicable |

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
| **Turn on indexing** (off by default) | Your chats | Your embedding provider and your vector database, where the text is stored in readable form |
| **Search your content** | Your search words | Your embedding provider and your vector database |
| **Use an assistant that can search the web**, if you connected a search key | Search terms written by the AI, which may reflect your conversation | Your web search provider (currently Tavily) |
| **Connect your own tool, MCP server or API** | Inputs the AI writes for that tool, which may reflect your conversation | The service you connected |
| **Use voice through the API** | Your audio and conversation context. Transcripts are saved as messages. | OpenAI or Google, using your key |
| **Add or save a key** | One small test request. Embedding keys also get a one-character test about once a week to check which models they can use. | That provider |

Unless you've connected a vector database and added an embedding key, nothing is sent for indexing.

When a provider offers a per-request option not to store your content, we use it.

### 1.3 Your API keys

- **Storage.** Your keys are encrypted with AWS Key Management Service before they are stored.
- **Use.** They are decrypted only in server memory, to make the requests described in section 1.2.
- **Visibility.** We never show a stored key again after you save it, and we don't share it with anyone except the provider it belongs to.
- **Removal.** You can delete all your stored keys and connections at once in Settings > Profile > Delete your data. Deleting a key doesn't delete anything that provider already holds, and data already in your vector database stays there.

### 1.4 What your providers do with your content

Provider practices differ, and some of the defaults may surprise you. **Please check the terms of each provider you connect**, especially whether it uses your content for training, how long it keeps it, and where it stores it.

As of November 2026, for example:

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

**Notes from earlier versions.** Earlier versions of the app had a notes editor. Notes saved with it are still stored, and the AI can still find them when it searches your content for a reply. To delete them, delete your account or email privacy@genflowly.com.

Your search index lives in **your** vector database, not ours. When you delete something, we also ask your vector database to delete it, as long as your connection details still work. If you have already removed them, or they have stopped working, you will need to delete that data from your vector database yourself.

### 1.6 Our commitments in BYOK mode

1. We send your content only to services you have connected, for the purposes described above.
2. Memory is on by default. You can turn off learning from your chats, and using what it learned in replies, each on its own. Indexing your chats for search is off until you turn it on.
3. Background tasks run only on your primary provider. If it fails, they don't move to another provider.
4. We don't use our own provider accounts for your requests.
5. We don't use your content to train AI models, and we don't sell it.

## Section 2: Pay-as-you-go

> **Pay-as-you-go is not available yet.** This section describes how it will work. It takes effect only when Pay-as-you-go launches, and before then we'll update it with the providers we use.

### 2.1 How Pay-as-you-go differs

In Pay-as-you-go you won't need your own provider accounts. We'll hold the contracts and API keys with third-party AI providers: the language models that write replies, and the embedding models that power search and memory. You'll pay us for what you use. This means **we choose the providers**, and they process your content on our behalf, as our sub-processors.

### 2.2 Where your content goes

Your content will follow the same paths as in section 1.2, except that the services will be ones we've chosen, running under our accounts. Before launch, we'll name the provider for each purpose here:

| Purpose | Receives |
|---|---|
| AI replies | Your messages, history, instructions, attachments, and anything the AI looks up for that reply |
| Titles, memory and other background tasks | What section 1.2 describes for these tasks |
| Embeddings, for search and memory | Text from chats you index, your memories, your search words, and the messages used to look up memories |
| Vector database | Indexed text, memories and related data, kept in a database shared between customers and separated by account |
| Web search | Search terms written by the AI |
| Payments | Your name, email, billing details and payment method |

### 2.3 How we'll limit what providers keep

Every provider we use in Pay-as-you-go will have to agree in writing to process your content only to provide the service to us. On top of that:

- **Zero data retention, on a best-effort basis.** We aim to use zero data retention with every provider, so that it doesn't store your prompts or its responses once it has replied. We'll turn it on wherever a provider makes it available to us. This is not a guarantee: not every provider or feature offers it, a provider can change its terms, and we rely on each provider to keep its own commitment.
- **No training.** None of our providers may use your content to train or improve their models. Where a provider's terms would otherwise allow it, we'll opt out before sending it any content. We won't use free tiers.
- **Short retention everywhere else.** Some providers don't offer zero data retention, offer it only for some features, or may not have approved it for us. They may keep prompts and responses for a limited period to detect abuse, and then delete them. We'll list each provider's period before launch.
- **Models that need retention are marked.** A few models are only available if the provider keeps content for a period, for example 30 days. We'll mark these in the model picker, so you can choose another model.
- **Safety and legal exceptions.** Even with zero data retention, a provider may keep content that its automated safety systems flag, and its staff may review it. Some providers keep flagged content for up to two years. Providers may also keep content where the law requires it.

Before launch, we'll list each provider here, with whether zero data retention is on, how long it may keep content, and where it processes it, and we'll give notice before adding one. We can't guarantee that deleting your data from our systems also removes what a provider holds during its retention period.

### 2.4 Payment information

Our payment processor will handle your card details, and we won't store them. We'll keep billing records and usage totals (such as token counts and amounts charged) for as long as tax and accounting laws require, even after you delete your account. These records won't contain your conversations.

### 2.5 Abuse prevention

Because requests will run under our accounts, we'll be responsible for how the service is used. We'll send providers a pseudonymous identifier for your account, never your name or email. Before launch, we'll describe here the automated checks we run, when flagged content may be reviewed and by whom, and how long it is kept.

### 2.6 Switching between modes

- **BYOK to Pay-as-you-go.** We won't copy data from your own vector database. Anything you want searchable in Pay-as-you-go will be indexed again only after you agree.
- **Pay-as-you-go to BYOK.** We'll offer to delete your data from the vector database we operate.
- **No silent mixing.** If a BYOK key is missing, your request fails. It never falls back to our accounts.

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
| **Diagnostics** (iOS app) | Crash and hang reports, failed requests, timings for a sample of app starts and requests, device model, iOS and app version, and a random identifier created when the app is installed | Generated automatically by the iOS app |
| **Reports and blocks** | Reports you make, or that others make about something you shared, with a copy of the reported content; and the people you block | You and other users |
| **Payment** (Pay-as-you-go only) | Billing details, handled by our payment processor | You |

Our application doesn't store your IP address. The infrastructure providers listed below process it to deliver the service and may keep it in their own logs.

We don't ask you to provide sensitive information. If you include it in your content, it is handled like the rest of your content and sent to the services described in this policy, so please consider this before sharing it.

### How we use it

| Purpose | Legal basis (where applicable) |
|---|---|
| Provide the app: run your requests, store and show your content, keep you signed in | Performance of our contract with you |
| Memory, which is on by default | Our legitimate interest in personalizing your replies. You can object by turning it off in Settings |
| Provide optional features you turn on, such as indexing and web search | Your consent, which you can withdraw in Settings |
| Keep the service secure and reliable: fix errors, prevent abuse, monitor performance | Our legitimate interest in running a secure service |
| Enforce our content rules: check what you share, review reports and act on them | Our legitimate interest in keeping the service safe for the people you share with |
| Show you your usage and costs, and bill you in Pay-as-you-go | Performance of our contract |
| Meet legal obligations | Legal obligation |

### What we don't do

- We don't sell or rent your personal information, or share it for advertising.
- We don't use your content to train AI models.
- We don't show ads.
- We don't use analytics or advertising trackers in our apps.
- We don't write your messages, memories or other content to our logs. Our logs contain identifiers and error information. Rarely, an error message from a provider may include a short fragment of your content. Content indexed before November 6, 2026 may remain in our background system's logs until November 12, 2026, and in its workflow history until February 4, 2027, when it is deleted automatically.

### Companies that help us run the app

| Company | What it does | What it handles |
|---|---|---|
| **Amazon Web Services** (United States) | Database, file storage, key encryption, background processing | Your account data and content, encrypted at rest |
| **Fly.io** (United States) | Runs our servers | Your content and keys in memory while processing requests |
| **Supabase** (United States) | Database that lets a reply in progress resume after an interruption | While a reply is being generated: your message, the conversation history and what's sent with it (instructions, memories, and notes or search results the AI looks up), and the reply so far. Deleted within an hour after the reply finishes. Never your API keys. |
| **Cloudflare** (global network) | Website hosting and delivery, security, routing of web app requests | Web app traffic, including your content in transit, and your IP address |
| **Auth0 by Okta** (United States) | Sign-in | Your sign-in details, email, name, picture, and login records |
| **Grafana Labs** | Service health dashboards and alerts | Performance metrics and operational logs |
| **Sentry** (United States) | Crash and performance reports from the iOS app | The diagnostics described under "Mobile app", and your IP address when a report arrives |
| **Apple** | iOS app distribution | As described in Apple's own terms. We don't send it your content. |

In Pay-as-you-go, the providers in section 2.2 will also process your content on our behalf.

**Website icons.** When an answer used web search, the app shows each source's small site icon, which your browser or phone loads directly from that website. Like opening any web page, this tells the site your IP address and that its icon was requested, which can suggest that your conversation involved it. No conversation text is sent, and sites whose icons can't be loaded show a letter instead.

These companies process your information under their data protection terms with us. We may also disclose information if the law requires it, to protect people's rights and safety, or as part of a merger or sale of our business, in which case this policy continues to apply unless we notify you otherwise.

### Sharing you choose

- **Public links.** Anyone with the link can read the conversation without signing in. That includes its messages and replies, the AI's activity trace, which can include text from your notes, memories and earlier conversations that the AI looked up for a reply, and your name and picture. Search engines may index these pages. Anything you share publicly may be copied by others. If you allow editing on a public link, anyone signed in who has the link can add to the conversation.
- **Sharing with specific people.** They can see the conversation, including prompts you wrote and replies you received.
- **Continuing a shared conversation.** When someone with edit access continues a conversation, its history is sent to the AI provider they use, under their own account.
- **Forks.** Someone with access to a conversation can copy it into their own account. **That copy remains theirs, even if you later delete the original or stop sharing it.**
- **Instructions and agents.** The ones you share become visible to the people you share them with.
- **Being discoverable.** This is off by default. If you turn it on, other users can find your username, name and picture when sharing.
- **Content rules.** What you share must follow our [content rules](https://genflowly.com/content-rules). Before something you share reaches anyone else, our servers check its text against a list of words and refuse it if one matches: when you share it or make it public, when you save an instruction that is shared, and when you add to a conversation someone shared with you. The check runs only on our servers. We record that something was refused, not what it said.
- **Reporting.** If you report something shared with you, we store the reason and note you give, the item's title, a copy of what you reported as it was at that moment (for a conversation, its most recent messages and replies), and the account identifiers and usernames of you and its owner. The report is emailed to our support team and listed in our moderation tool, where our staff review it. We don't tell the owner who reported it. If it breaks the rules, we may make the item private, which removes its shares and its public link.
- **Blocking.** If you block someone, we store who you blocked, when, and their username and name at that time. Neither of you can then find the other by username, share with the other, or see the other's shared items while signed in, and any shares between you are removed. We don't notify them, but they may notice. Public links still open for people who aren't signed in.
- **Connected tools and services.** Anything you connect receives what section 1.2 describes.

Deleting a conversation ends its public link and its shares. If someone shared a conversation with you, deleting it removes only your own access.

### How long we keep your data

| Data | How long |
|---|---|
| **Conversations, attachments and generated files** | Until you delete them or your account. |
| **Notes saved in earlier versions of the app** | Until you delete your account, or ask us to delete them. |
| **Deleted items** | Erased from our active systems shortly after you delete them. Copies in backups expire within 35 days. |
| **Memories** | Until you delete them or your account. A memory keeps its earlier versions and its history until it is deleted. Deleting a conversation doesn't delete the memories learned from it. |
| **Replies in progress** | Deleted from Supabase within an hour after the reply finishes. The finished reply is kept with its conversation. |
| **Temporary files used by AI tools** | 1 day for files created since November 6, 2026. Files created before then are kept until they are deleted. |
| **API keys and connection details** | Until you delete them or your account. |
| **Account details** | Until you delete your account. Your sign-in record with Auth0 is deleted on request. |
| **Backups** | Deleted data can remain in encrypted backups for up to 35 more days, then it is gone. |
| **Operational logs** | Currently kept indefinitely. |
| **Crash and performance reports** | Up to 90 days in Sentry, then deleted automatically. |
| **Blocks** | Until you unblock the person, or either of your accounts is deleted. |
| **Reports** | Kept after the reported item or either account is deleted, as a record of what we did and to recognize repeated abuse. Currently kept indefinitely. |
| **Usage totals** | For the life of your account. In Pay-as-you-go, billing records will be kept as section 2.4 describes. |
| **Copies on your device** | Until you sign out. |
| **Providers you use** | In BYOK, set by each provider's own terms, and we can't delete what they hold. In Pay-as-you-go, as section 2.3 describes. |

### Security

- Connections to our apps and to outside providers are encrypted in transit. Our internal services communicate over a private network.
- Data in our databases and file storage is encrypted at rest.
- API keys receive an extra layer of encryption with AWS Key Management Service.
- Stored files are private, and access links expire within an hour.

No system is perfectly secure. If a breach affects your information, we'll notify you and the relevant authorities as the law requires.

### Who at Unbiase AI can see your content

Our systems process your content automatically, and it is not end-to-end encrypted, so authorized staff have the technical ability to access it. We access it only when necessary to fix a problem you report or that affects the service, to protect security, or to comply with the law. When something is reported, our staff see the copy stored with the report. Access is limited to people who need it.

### Your rights and choices

**In the app, at any time:**

| You can... | Where |
|---|---|
| See your profile and change your username | Settings |
| Delete a conversation | The conversation's menu |
| See, edit and delete what memory has learned, and see where each fact came from and which replies used it | The Memory page |
| Turn memory off, or delete everything it has learned | Settings > Defaults > Learned facts |
| Turn indexing on or off, and delete indexed chats | Settings > Defaults > Search index |
| Delete all your API keys | Settings > Profile > Delete your data |
| Stop sharing a conversation | Share menu |
| Report something shared with you, or block its owner | The item's menu |
| Block someone you shared with | Share menu |
| See and unblock the people you've blocked | Settings > Profile > Blocked users |
| Delete your account | Settings > Profile > Delete your data |

**By email:** to get a copy of your data, or to delete notes saved in earlier versions of the app, email privacy@genflowly.com.

**By law.** Depending on where you live, you may have the right to access, correct, delete, or receive a copy of your personal information, to restrict or object to how we use it, and to withdraw consent. To use these rights, email privacy@genflowly.com. We'll respond within 30 days, and we won't treat you differently for using them. If you're unhappy with our response, you can complain to your local data protection authority.

**California residents.** We don't sell personal information or share it for cross-context behavioral advertising. The categories we collect and use are described above. You have the right to know, delete and correct your information, and to appoint an authorized agent to do so.

### International transfers

We're based in Seattle, Washington, in the United States, and our main systems are in the United States (AWS, Fly.io and Supabase in the Virginia region). Cloudflare operates a global network. In BYOK mode your content also goes wherever your chosen providers and vector database are located. In Pay-as-you-go, our providers will process it in the locations we list in section 2 before launch. Where the law requires it, we rely on appropriate safeguards for transfers, such as Standard Contractual Clauses.

### Children

Unbiase AI isn't intended for anyone under 13, or under 16 in the EEA and the UK. Some AI providers set a higher minimum age. If you believe a child has given us personal information, email privacy@genflowly.com and we'll delete it.

### Cookies and local storage

We don't use advertising or analytics cookies.

- **Sign-in.** Auth0 uses cookies to keep you signed in.
- **Security.** Cloudflare may use cookies and a small script to detect automated traffic.
- **Your browser's local storage.** The web app stores sign-in tokens, your memories, conversation titles, instructions, agents and display preferences so that the app loads quickly. Signing out clears everything except your theme choice. Please sign out on shared devices.

### Mobile app

The iOS app stores conversation history, memories, instructions and unsent drafts on your device so that they open quickly, and keeps sign-in tokens in the iOS Keychain. Signing out clears this data, apart from your theme choice. The camera is used only if you take a photo to attach. The app doesn't track you across other companies' apps or websites.

When the iOS app crashes, freezes or hits an error, it sends a report to Sentry so we can find and fix the cause. A report says where in the app's code the problem happened and what the app did just before it, such as which screens opened and which of our server addresses it called, with their status codes. It also includes your device model, iOS version, free memory and storage, the app version, and a random identifier created when the app is installed. The app also sends timings for a small sample of app starts and requests. Reports don't include your messages, memories, attachments, API keys, name or email. Rarely, an error message may include a short fragment of your content. These reports aren't used for analytics or advertising.

Before any of your content is first sent to an AI service, the web and iOS apps ask for your permission and explain which kinds of services receive it. You can review this in Settings > Profile.

### Changes to this policy

We'll post any change here and update the date above. If a change materially affects how we use your information, we'll notify you in the app or by email before it takes effect.

### Contact

Genflowly, Seattle, Washington, United States
