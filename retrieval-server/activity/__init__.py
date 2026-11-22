"""Agent activity log: the data behind the response card's thinking panel.

The graph's nodes only record facts in their own outputs (trace entries,
scratch, tool sources). This package is the single place that knows the wire
shape the clients render: `recorder` turns LangGraph's event stream into
activity events, `schema` defines and validates those events.
"""
from activity.recorder import ActivityRecorder
from activity.schema import ACTIVITY_VERSION

__all__ = ["ActivityRecorder", "ACTIVITY_VERSION"]
