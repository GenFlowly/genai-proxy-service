"""
Unit tests for ReferenceTail: the answer stream's hold on a trailing list of
references for citations from the model's own knowledge.

Run with `python -m unittest tests.test_knowledge_references`.
"""
import unittest

from graph.knowledge_references import ReferenceTail

_ANSWER = (
    "Defaults matter.[1] Sludge hurts.[2]\n\nMore prose here.[3]\n\n### Sources\n\n"
    "[1] Madrian & Shea, *Quarterly Journal of Economics*, 2001.  \n"
    "[2] Sunstein, *Sludge*, 2021.\n"
    "[3]: Gollwitzer & Sheeran, 2006."
)


def _run(chunks, taken=()):
    tail = ReferenceTail()
    streamed = "".join(tail.feed(chunk) for chunk in chunks)
    rest, sources = tail.finish(taken)
    return streamed, rest, sources


def _chunks(text, size):
    return [text[i:i + size] for i in range(0, len(text), size)]


class ReferenceTailTests(unittest.TestCase):
    def test_the_list_never_streams_and_becomes_training_sources(self):
        for size in (1, 2, 5, 13, len(_ANSWER)):
            with self.subTest(chunk_size=size):
                streamed, rest, sources = _run(_chunks(_ANSWER, size))
                self.assertEqual(streamed, "Defaults matter.[1] Sludge hurts.[2]\n\nMore prose here.[3]\n")
                self.assertEqual(rest, "")
                self.assertEqual(sources, [
                    {"index": 1, "title": "Madrian & Shea, Quarterly Journal of Economics, 2001.", "url": "", "origin": "training"},
                    {"index": 2, "title": "Sunstein, Sludge, 2021.", "url": "", "origin": "training"},
                    {"index": 3, "title": "Gollwitzer & Sheeran, 2006.", "url": "", "origin": "training"},
                ])

    def test_the_asked_for_form_without_a_heading(self):
        streamed, rest, sources = _run(_chunks("A claim.[4]\n\n[4]: Kahneman, Thinking, Fast and Slow, 2011", 3))
        self.assertEqual(streamed, "A claim.[4]\n")
        self.assertEqual(rest, "")
        self.assertEqual([s["index"] for s in sources], [4])

    def test_the_asked_for_form_counts_even_when_the_text_has_no_markers(self):
        text = "Johnson & Goldstein (2003) found large effects.\n\n[1]: Johnson, Goldstein, Do Defaults Save Lives?, Science, 2003"
        streamed, rest, sources = _run(_chunks(text, 6))
        self.assertEqual(streamed + rest, "Johnson & Goldstein (2003) found large effects.\n")
        self.assertEqual([s["index"] for s in sources], [1])

    def test_text_after_a_held_line_lets_it_go(self):
        text = "See [1].\n[1] is the first step\nand then more text."
        streamed, rest, sources = _run(_chunks(text, 4))
        self.assertEqual(streamed + rest, text)
        self.assertEqual(sources, [])

    def test_a_bracketed_list_the_answer_never_cites_is_kept_as_text(self):
        text = "Steps:\n[1] Do X\n[2] Do Y"
        streamed, rest, sources = _run([text])
        self.assertEqual(streamed + rest, text)
        self.assertEqual(sources, [])

    def test_a_heading_word_inside_prose_is_not_held(self):
        text = "Sources are good.\nReferences matter too."
        streamed, rest, sources = _run(_chunks(text, 1))
        self.assertEqual(streamed + rest, text)
        self.assertEqual(sources, [])

    def test_a_tool_source_number_wins(self):
        _, rest, sources = _run(["A [5] claim and [1].\n\n[5]: Ref five\n[1]: duplicate"], taken=[1])
        self.assertEqual(rest, "")
        self.assertEqual(sources, [{"index": 5, "title": "Ref five", "url": "", "origin": "training"}])

    def test_reset_drops_a_preamble_and_its_markers(self):
        tail = ReferenceTail()
        tail.feed("Let me check [1].\n")
        tail.reset()
        streamed = tail.feed("Final answer.\n\n[1] Ref")
        rest, sources = tail.finish()
        # [1] was cited only in the preamble, and there is no heading.
        self.assertEqual(streamed + rest, "Final answer.\n\n[1] Ref")
        self.assertEqual(sources, [])

    def test_links_in_a_reference_keep_their_text(self):
        _, _, sources = _run(["X.[2]\n\n[2]: [Nudge](https://example.com), Thaler, 2008"])
        self.assertEqual(sources[0]["title"], "Nudge, Thaler, 2008")


if __name__ == "__main__":
    unittest.main()
