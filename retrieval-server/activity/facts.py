"""The one hook graph nodes call to report activity facts mid-step.

A tools step's calls run concurrently and can take seconds each; reporting
each call as it finishes lets the panel tick queries off live instead of
waiting for the whole round. Nodes stay unaware of the wire shape: they send
the call's facts, the recorder (which receives them as a LangGraph custom
event) decides what reaches the client.
"""
import logging

from activity.schema import CALL_FINISHED_EVENT

logger = logging.getLogger(__name__)


async def report_call(facts: dict) -> None:
    """Best effort. Outside a LangGraph run (direct calls in unit tests) there
    is no run to attach the event to; the step's end still carries the call."""
    try:
        from langchain_core.callbacks.manager import adispatch_custom_event

        await adispatch_custom_event(CALL_FINISHED_EVENT, facts)
    except Exception as e:
        logger.debug("activity: call report not dispatched (%s)", e)
