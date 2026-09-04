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
- **`ToolResult`** — `content` (text fed back to the model as the tool result)
  plus `artifacts` (files for the host to persist references to and expose for
  download).

## Tools

| Tool | Description | Extra deps |
|---|---|---|
| `generate_pdf` | Render markdown into a styled PDF artifact | `markdown`, `xhtml2pdf` |

## Usage sketch

```python
from graph_tools import ToolContext, S3ArtifactStore, default_registry

registry = default_registry()
llm = llm.bind_tools(caller_tools + registry.specs(enabled_names))

context = ToolContext(
    customer_id=customer_id,
    store=S3ArtifactStore(bucket="attachments"),
    key_template="customers/{customer_id}/attachments/{artifact_id}",
)
for call in tool_calls:
    if registry.has(call["name"]):
        result = await registry.get(call["name"]).run(call["args"], context)
```
