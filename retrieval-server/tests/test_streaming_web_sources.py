"""
Unit tests for the end-of-turn cited-only web_sources trimming in
stream_events_dicts (and the _cited_web_sources helper it rides on).

Run with `python -m unittest tests.test_streaming_web_sources`.

Models search broadly but cite narrowly: the mid-turn web_sources snapshots
carry every result of every search, while the answer cites a handful. At end
of turn the stream emits ONE more web_sources event holding only the cited
entries (original indices preserved — clients resolve [n] markers via the
`index` field, not array position). Consumers treat web_sources as
last-write-wins, so this single event trims the live panel and what the proxy
persists, while the activity log keeps the full per-call lists.

The graph is faked exactly as in test_streaming_content_reset: the function
only consumes `astream_events`, so hand-built v2 events exercise the real
logic without a model or a compiled LangGraph.
"""
import unittest

from langchain_core.messages import AIMessage, AIMessageChunk

from streaming import stream_events_dicts, _cited_web_sources

_GEN = "GEN_NODE"
_EXEC = "EXEC_NODE"
_NODE_TYPES = {_GEN: "RESPONSE_GENERATOR", _EXEC: "TOOL_EXECUTOR"}

_SOURCES = [
    {"index": 1, "title": "One", "url": "https://one.example"},
    {"index": 2, "title": "Two", "url": "https://two.example"},
    {"index": 3, "title": "Three", "url": "https://three.example"},
]


class _FakeGraph:
    def __init__(self, events):
        self._events = events

    async def astream_events(self, state, config=None, version=None):
        for event in self._events:
            yield event


def _stream_event(text: str) -> dict:
    return {
        "event": "on_chat_model_stream",
        "metadata": {"langgraph_node": _GEN},
        "data": {"chunk": AIMessageChunk(content=text)},
    }


def _model_end_event(tool_calls: list) -> dict:
    output = AIMessage(
        content="",
        tool_calls=[
            {"name": name, "args": {}, "id": f"id-{i}", "type": "tool_call"}
            for i, name in enumerate(tool_calls)
        ],
    )
    return {
        "event": "on_chat_model_end",
        "metadata": {"langgraph_node": _GEN},
        "data": {"output": output},
    }


def _executor_end_event(sources: list) -> dict:
    return {
        "event": "on_chain_end",
        "name": _EXEC,
        "metadata": {"langgraph_node": _EXEC},
        "data": {"output": {"tool_sources": sources}},
    }


async def _collect(events):
    payloads = []
    async for payload in stream_events_dicts(
        {"llm_provider": "openai", "customer_id": "cust-1"},
        graph=_FakeGraph(events),
        node_type_map=_NODE_TYPES,
        streaming_nodes={_GEN},
        builtin_tool_names={"web_search"},
    ):
        payloads.append(payload)
    return payloads


def _web_sources_events(payloads):
    return [p["web_sources"] for p in payloads if "web_sources" in p]


def _content(payloads):
    return "".join(p["content"] for p in payloads if "content" in p)


class KnowledgeCitationTests(unittest.IsolatedAsyncioTestCase):
    """The answer's own reference lines become training sources in the final
    web_sources event and never reach the content stream."""

    async def test_a_turn_without_tools_gets_training_sources(self):
        payloads = await _collect([
            _stream_event("Defaults work.[1]\n\n"),
            _stream_event("[1]: Madrian & Shea, *QJE*, 2001"),
            _model_end_event([]),
        ])
        self.assertEqual(_content(payloads), "Defaults work.[1]\n")
        self.assertEqual(_web_sources_events(payloads), [[
            {"index": 1, "title": "Madrian & Shea, QJE, 2001", "url": "", "origin": "training"},
        ]])

    async def test_training_sources_follow_the_cited_tool_sources(self):
        payloads = await _collect([
            _stream_event("Searching."),
            _model_end_event(["web_search"]),
            _executor_end_event(_SOURCES),
            _stream_event("Use Two [2]. Also known [4].\n\n[4]: Kahneman, 2011"),
            _model_end_event([]),
        ])
        self.assertEqual(_web_sources_events(payloads)[-1], [
            _SOURCES[1],
            {"index": 4, "title": "Kahneman, 2011", "url": "", "origin": "training"},
        ])
        self.assertNotIn("Kahneman", _content(payloads))

    async def test_an_answer_without_reference_lines_is_unchanged(self):
        payloads = await _collect([
            _stream_event("Plain answer.\n"),
            _stream_event("Second line."),
            _model_end_event([]),
        ])
        self.assertEqual(_content(payloads), "Plain answer.\nSecond line.")
        self.assertEqual(_web_sources_events(payloads), [])


class TrimmingTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_event_holds_only_cited_entries_with_original_indices(self):
        payloads = await _collect([
            _stream_event("Searching."),
            _model_end_event(["web_search"]),
            _executor_end_event(_SOURCES),
            _stream_event("Use Two [2] for this."),
            _model_end_event([]),
        ])

        events = _web_sources_events(payloads)
        self.assertEqual(len(events), 2)  # full mid-turn snapshot, then trimmed
        self.assertEqual(events[0], _SOURCES)
        self.assertEqual(events[1], [_SOURCES[1]])  # index preserved, not renumbered
        # The trimmed event precedes usage, so last-write-wins consumers keep it.
        self.assertLess(
            max(i for i, p in enumerate(payloads) if "web_sources" in p),
            payloads.index(next(p for p in payloads if "usage" in p)),
        )

    async def test_uncited_answer_keeps_the_full_list(self):
        # A model that searched but cited nothing keeps full provenance.
        payloads = await _collect([
            _executor_end_event(_SOURCES),
            _stream_event("No citations here."),
            _model_end_event([]),
        ])
        self.assertEqual(_web_sources_events(payloads), [_SOURCES])

    async def test_preamble_citations_do_not_count(self):
        # [1] appears only in the tool-call preamble, which content_reset
        # discards — the final answer cites [3] alone.
        payloads = await _collect([
            _stream_event("Checking source [1] again."),
            _model_end_event(["web_search"]),
            _executor_end_event(_SOURCES),
            _stream_event("Answer per [3]."),
            _model_end_event([]),
        ])
        self.assertEqual(_web_sources_events(payloads)[-1], [_SOURCES[2]])

    async def test_turn_end_carries_what_the_answer_cites(self):
        # The activity log's turn.end names the cited indices, so the panel
        # never guesses from interim full lists. A preamble's marker and a
        # marker matching no source are not citations.
        payloads = await _collect([
            _stream_event("Checking source [1] again."),
            _model_end_event(["web_search"]),
            _executor_end_event(_SOURCES),
            _stream_event("Answer per [3] and [2], not [9]."),
            _model_end_event([]),
        ])
        turn_end = [p["activity"] for p in payloads if "activity" in p][-1]
        self.assertEqual(turn_end["type"], "turn.end")
        self.assertEqual(turn_end["cited"], [2, 3])

    async def test_turn_end_has_an_empty_citation_list_for_an_uncited_answer(self):
        payloads = await _collect([
            _executor_end_event(_SOURCES),
            _stream_event("No citations here."),
            _model_end_event([]),
        ])
        turn_end = [p["activity"] for p in payloads if "activity" in p][-1]
        self.assertEqual(turn_end["cited"], [])

    async def test_everything_cited_emits_no_extra_event(self):
        payloads = await _collect([
            _executor_end_event(_SOURCES),
            _stream_event("See [1], [2] and [3]."),
            _model_end_event([]),
        ])
        self.assertEqual(_web_sources_events(payloads), [_SOURCES])

    async def test_markers_matching_nothing_keep_the_full_list(self):
        # e.g. code snippets like arr[9] — a full list beats an empty one.
        payloads = await _collect([
            _executor_end_event(_SOURCES),
            _stream_event("The value is arr[9]."),
            _model_end_event([]),
        ])
        self.assertEqual(_web_sources_events(payloads), [_SOURCES])


class CitedWebSourcesHelperTests(unittest.TestCase):
    def test_no_sources_or_no_answer_is_none(self):
        self.assertIsNone(_cited_web_sources([], "see [1]"))
        self.assertIsNone(_cited_web_sources(_SOURCES, ""))

    def test_multiple_markers_and_repeats_dedupe(self):
        trimmed = _cited_web_sources(_SOURCES, "A [1] then [3], [1] again")
        self.assertEqual(trimmed, [_SOURCES[0], _SOURCES[2]])

    def test_markers_inside_existing_markdown_links_still_count(self):
        trimmed = _cited_web_sources(_SOURCES, "Per [2](https://two.example).")
        self.assertEqual(trimmed, [_SOURCES[1]])


if __name__ == "__main__":
    unittest.main()
