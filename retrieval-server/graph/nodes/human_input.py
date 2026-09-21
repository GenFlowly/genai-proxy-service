import logging
from typing import Optional

from langgraph.types import interrupt

from graph.nodes.llm_node import _render_template, _route_output, _trace_entry
from graph.state import RetrievalState

logger = logging.getLogger(__name__)


def human_input(node_id: Optional[str] = None):
    """
    In-graph human-in-the-loop node (durable /runs path).

    Calls LangGraph interrupt() to PAUSE the graph and surface a request for
    input. The durable run then waits (agent_run → DBOS.recv, survives
    crash/redeploy) until POST /runs/{id}/resume delivers a value; interrupt()
    returns that value and this node writes it into state, and the graph resumes
    from the checkpoint.

    Config (DDB CustomerGraphNodes.config):
      prompt      (str) — request shown to the human; {state} placeholders rendered
      output_key  (str) — state field to store the response (default: human_response)

    Durable-only: on the stateless /retrieve path there is no waiter to deliver a
    resume, so this node is meant for /runs.
    """
    async def node(state: RetrievalState) -> dict:
        configs = state.get("node_configs", {})
        config = (configs.get(node_id) if node_id else None) or configs.get("HUMAN_INPUT", {})
        prompt_template = config.get("prompt", "Input is needed to continue.")
        output_key = config.get("output_key", "human_response")

        prompt = _render_template(prompt_template, state)
        logger.info("Node HUMAN_INPUT (%s): interrupting for input", node_id)
        # Pause the graph. On resume, `value` is whatever POST /runs/{id}/resume
        # delivered (a string or a JSON object).
        value = interrupt({"type": "human_input", "node": node_id, "prompt": prompt})
        logger.info("Node HUMAN_INPUT (%s): resumed with input", node_id)

        text = value if isinstance(value, str) else str(value)
        return {
            **_route_output(output_key, value),
            **_trace_entry("HUMAN_INPUT", prompt, text),
        }

    node.__name__ = f"human_input_{(node_id or 'default').lower()}"
    return node
