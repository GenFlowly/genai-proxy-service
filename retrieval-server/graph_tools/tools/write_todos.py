"""write_todos: the agent's working plan, maintained as a checklist.

Planning tool in the Claude Code / Deep Agents mold: not execution machinery,
but context anchoring — on long multi-step runs the model restates and updates
its plan, which keeps it on task across many tool rounds and gives the user a
live view of progress (the host surfaces the list in its thinking panel and
persists it with the turn).

The model always passes the FULL list; each call replaces the previous list
wholesale (no diff protocol to get wrong). The current list is handed back to
the host through ToolResult.state_patch["todos"], so it survives across loop
iterations in run state rather than only in message history.

Self-contained: stdlib only.
"""
import logging

from graph_tools.base import GraphTool, ToolContext, ToolResult

logger = logging.getLogger(__name__)

_STATUSES = ("pending", "in_progress", "completed")
_MAX_ITEMS = 50
_MAX_ITEM_CHARS = 500
_CHECKBOX = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}


def _normalize(raw) -> list[dict]:
    """Model-supplied items → [{content, status}], clamped and cleaned.
    Strings are accepted as pending items; junk entries are dropped rather
    than failing the whole update."""
    items: list[dict] = []
    for entry in (raw or [])[:_MAX_ITEMS]:
        if isinstance(entry, str):
            content, status = entry.strip(), "pending"
        elif isinstance(entry, dict):
            content = str(entry.get("content") or "").strip()
            status = entry.get("status") if entry.get("status") in _STATUSES else "pending"
        else:
            continue
        if content:
            items.append({"content": content[:_MAX_ITEM_CHARS], "status": status})
    return items


def render_todos(todos: list[dict]) -> str:
    return "\n".join(f"{_CHECKBOX[t['status']]} {t['content']}" for t in todos)


class WriteTodosTool(GraphTool):
    name = "write_todos"
    credential_ref = None
    description = (
        "Maintain your task plan as a todo checklist. Use it for any task with "
        "three or more steps: write the full plan before starting, then call "
        "again whenever an item's status changes — mark the item you are "
        "working on in_progress (only one at a time) and mark items completed "
        "the moment they are done. Always pass the COMPLETE list; it replaces "
        "the previous one. Skip it entirely for trivial single-step requests."
    )
    parameters = {
        "type": "object",
        "properties": {
            "todos": {
                "type": "array",
                "description": "The complete, current task list.",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The task, short and imperative.",
                        },
                        "status": {
                            "type": "string",
                            "enum": list(_STATUSES),
                        },
                    },
                    "required": ["content", "status"],
                },
            },
        },
        "required": ["todos"],
    }

    async def run(self, args: dict, context: ToolContext) -> ToolResult:
        raw = args.get("todos")
        if not isinstance(raw, list):
            return ToolResult(
                content="Error: todos must be a list of {content, status} items."
            )
        todos = _normalize(raw)
        if not todos:
            # An empty list is a legal "plan cleared" state.
            return ToolResult(content="Todo list cleared.", state_patch={"todos": []})
        done = sum(1 for t in todos if t["status"] == "completed")
        return ToolResult(
            content=(
                f"Todo list updated ({done}/{len(todos)} completed):\n"
                f"{render_todos(todos)}"
            ),
            state_patch={"todos": todos},
        )
