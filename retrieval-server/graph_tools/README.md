# graph_tools

Built-in, backend-executed tools for LangGraph agent loops. The model decides
*when* to call a tool; this package owns *what the tool does* — so behavior is
identical across LLM vendors and model switches.

Self-contained: no imports from the host application, storage behind an
injected `ArtifactStore` (S3 or local disk). Designed to be extracted into a
standalone open-source library.

## Concepts

- **`GraphTool`** — a tool: `name` + `description` + JSON-Schema `parameters`
  (the spec the model sees) and an async `run(args, context)` (what the backend
  executes).
- **`ToolRegistry`** — name → tool map; `specs(names)` returns the vendor-
  agnostic specs to bind to the LLM. `default_registry()` has every built-in
  tool registered.
- **`ToolContext`** — per-request context: customer id, an `ArtifactStore`,
  and the host's storage-key template. Tools persist files only through
  `context.save_artifact(...)`.
- **`ToolResult`** — `content` (text fed back to the model as the tool result),
  `artifacts` (files for the host to persist references to and expose for
  download), and `sources` (see below).
- **`Source`** — a citable source a tool grounded its result in (`title`, `url`,
  optional `content` snippet and `published_date`). This is the one citation
  path for every tool: a tool returns bare sources and **does not number them**;
  the host assigns a turn-global `[n]` index, renders them into the tool's text
  for the model, and forwards `{index, title, url}` to the client so the inline
  `[n]` markers in the answer become clickable links. When `sources` is set,
  keep `content` a short preamble, not a hand-numbered list.

- **`ToolContext.secrets`** — maps a tool's `credential_ref` to the caller's
  decrypted credential values for this request. A plain callable over an
  already-resolved map, never a live fetch: the host resolves once per run, off
  the event loop. Tools never read process environment variables (shared by
  every tenant) and no secret ever enters graph state.

## Built-in tools

Code we ship. Customer-independent behaviour; only their credentials differ.

| Tool | Description | Credential | Extra deps |
|---|---|---|---|
| `generate_pdf` | Render markdown into a styled PDF artifact | none | `markdown`, `xhtml2pdf` |
| `web_search` | Search the web via Tavily | `WEB_SEARCH` | `httpx` |

## Providers: tools that are records, not code

`providers/` is the tier that lets a tool be added without a deploy. A provider
interprets a stored, non-secret record and yields an ordinary `GraphTool`, so
nothing downstream knows the difference.

| Provider | Record describes | Status |
|---|---|---|
| `http` (`HttpTool`) | one HTTP request: method, URL, headers, query, body, response transform | shipped |
| `mcp` (`McpTool`) | one Model Context Protocol server, expanding to many tools | shipped |

`providers/openapi.py` is not a provider but a translator that feeds one: it
turns an OpenAPI or Swagger document into `http` records, so importing a spec is
the cheapest route from "I want my agent to use this service" to a working tool.
It touches no network and no storage — fetching the document is the caller's job,
through the hardened client, because the URL comes from the user. An operation it
cannot represent honestly is skipped with a reason rather than imported
half-built.

The `mcp` provider binds from a manifest PINNED when the customer connected the
server, and never calls it at bind time. A tool's description is text placed
directly into the model's context, so a server free to rewrite it between turns
could steer the agent through a channel the customer never sees. A changed
manifest is something someone re-approves.

Two properties carry the security of the `http` provider, because a tool's
arguments are written by the model and a user can steer the model with pasted
text:

1. **The destination is pinned when the tool is defined.** Placeholders are
   rejected in the URL scheme and host; only the path, query, headers and body
   may be templated, and the assembled URL's origin is re-checked before the
   call. A prompt-injected argument can change the request's content, never
   where it goes. Path values are percent-encoded with an empty safe set so an
   argument cannot escape its segment.
2. **Substitution is not evaluation.** No expression language, no second pass.
   A value that is itself `{{credential.api_key}}` is not re-substituted, and a
   placeholder naming an unknown key is an error rather than an empty string.

`providers/safe_client.py` refuses what an ordinary client would do from inside
a private network: non-https destinations, hosts resolving to loopback, private,
link-local or reserved addresses, redirects, unbounded time or size, and
caller-set transport headers. Its one known gap — DNS rebinding between
validation and connection — is documented in that module rather than left to be
discovered.

## Usage sketch

```python
from graph_tools import ToolContext, S3ArtifactStore, default_registry
from graph_tools.providers import HttpTool

# Built-ins plus whatever the customer has defined, resolved for THIS request.
tools = {t.name: t for t in registry_tools(enabled_names)}
tools.update({r["name"]: HttpTool(r) for r in customer_records})

llm = llm.bind_tools(caller_tools + [t.spec for t in tools.values()])

# Credentials resolved once, off the event loop, and handed in by reference.
resolved = await resolve_credentials(customer_id, {t.credential_ref for t in tools.values()})
context = ToolContext(
    customer_id=customer_id,
    store=S3ArtifactStore(bucket="attachments"),
    key_template="customers/{customer_id}/attachments/{artifact_id}",
    secrets=lambda ref: resolved.get(ref, {}),
)
for call in tool_calls:
    if call["name"] in tools:
        result = await tools[call["name"]].run(call["args"], context)
```

In this server those steps live in `graph/tools_runtime.py` (resolution),
`graph/customer_tools.py` (records), `graph/tool_credentials.py` (secrets) and
`graph/nodes/tool_executor.py` (execution).
