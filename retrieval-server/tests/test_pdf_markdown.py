"""
Unit tests for graph_tools.tools.pdf_markdown: the Markdown -> token tree
contract (plan item 2.2) that the Typst template consumes.

The rendered-PDF versions of these checks live in tests/test_pdf_typst.py.
Run with `python -m unittest tests.test_pdf_markdown`.
"""
import json
import os
import unittest

from graph_tools.tools import pdf_markdown as pm

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "pdf")


def _fixture(name: str) -> str:
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


def _walk(node):
    """Every dict node in document order (cells, terms and footnotes included)."""
    if isinstance(node, list):
        for n in node:
            yield from _walk(n)
        return
    if not isinstance(node, dict):
        return
    yield node
    for key in ("children", "header", "term", "footnotes"):
        if key in node:
            yield from _walk(node[key])
    for row in node.get("rows", []):
        yield from _walk(row)
    for definition in node.get("definitions", []):
        yield from _walk(definition)


def _of_type(tree, node_type):
    return [n for n in _walk(tree) if n.get("type") == node_type]


def _texts(tree):
    return [n["value"] for n in _of_type(tree, "text")]


def _item_text(item) -> str:
    """Plain text of a list item's first paragraph."""
    para = item["children"][0]
    return pm.plain_text(para["children"])


def _find_item(tree, text):
    """(list node, index, item) of the list item whose first line is `text`."""
    for lst in _of_type(tree, "bullet_list") + _of_type(tree, "ordered_list"):
        for idx, item in enumerate(lst["children"]):
            if item["children"] and item["children"][0]["type"] == "paragraph" and _item_text(item) == text:
                return lst, idx, item
    raise AssertionError(f"no list item {text!r}")


def _sublists(item):
    return [c for c in item["children"] if c["type"] in ("bullet_list", "ordered_list")]


class TreeShapeTests(unittest.TestCase):
    def test_tree_is_json_serializable_and_versioned(self):
        tree = pm.parse(_fixture("19_misc_markdown.md"))
        self.assertEqual(tree["type"], "doc")
        self.assertEqual(tree["version"], pm.TREE_VERSION)
        self.assertEqual(pm.TREE_VERSION, 1)
        self.assertEqual(json.loads(json.dumps(tree)), tree)

    def test_empty_input(self):
        tree = pm.parse("")
        self.assertEqual(tree["children"], [])
        self.assertEqual(tree["footnotes"], [])
        self.assertIsNone(pm.first_h1_text(tree))


class LlmHabitsTests(unittest.TestCase):
    """22_llm_habits.md: the defects D7 and D8 at tree level."""

    def setUp(self):
        self.tree = pm.parse(_fixture("22_llm_habits.md"))
        self.blocks = self.tree["children"]

    def test_paragraph_then_three_item_bullet_list(self):
        types = [b["type"] for b in self.blocks]
        idx = next(i for i, b in enumerate(self.blocks)
                   if b["type"] == "paragraph" and pm.plain_text(b) == "Your benefits include:")
        self.assertEqual(types[idx + 1], "bullet_list")
        items = self.blocks[idx + 1]["children"]
        self.assertEqual([_item_text(i) for i in items],
                         ["Health insurance", "25 days of paid leave", "Stock options"])

    def test_table_after_a_paragraph_line_has_two_columns(self):
        tables = _of_type(self.tree, "table")
        self.assertEqual(len(tables), 1)
        table = tables[0]
        self.assertEqual(len(table["align"]), 2)
        self.assertEqual([pm.plain_text(c) for c in table["header"]], ["Item", "Amount"])
        self.assertEqual([[pm.plain_text(c) for c in r] for r in table["rows"]],
                         [["Base salary", "$120,000"], ["Bonus", "10%"]])
        self.assertFalse(any("|" in t for t in _texts(self.tree)))

    def test_angle_bracket_placeholders_are_literal_text(self):
        texts = _texts(self.tree)
        self.assertIn("Dear <Candidate Name>,", texts)
        self.assertIn("<Your Name>", texts)
        self.assertTrue(any("<Job Title>" in t for t in texts))

    def test_parenthesised_ordered_list_keeps_its_delimiter(self):
        lst, idx, _ = _find_item(self.tree, "First parenthesised item")
        self.assertEqual(lst["type"], "ordered_list")
        self.assertEqual(lst["delimiter"], ")")
        self.assertEqual(idx, 0)


class NestedListTests(unittest.TestCase):
    """14_nested_lists.md and the D9 probe: CommonMark nesting, no renumbering."""

    def test_first_level_three_is_item_three(self):
        tree = pm.parse(_fixture("14_nested_lists.md"))
        lst, idx, _ = _find_item(tree, "First level three")
        self.assertEqual(lst["type"], "ordered_list")
        self.assertEqual(lst["start"] + idx, 3)
        self.assertEqual(len(lst["children"]), 3)

    def test_three_space_children_nest_one_level_below(self):
        tree = pm.parse(_fixture("14_nested_lists.md"))
        _, _, parent = _find_item(tree, "First level one")
        (sub,) = _sublists(parent)
        self.assertEqual(sub["type"], "bullet_list")
        self.assertEqual([_item_text(i) for i in sub["children"]],
                         ["Second level bullet", "Second bullet again"])
        _, _, two = _find_item(tree, "First level two")
        (sub2,) = _sublists(two)
        self.assertEqual(sub2["type"], "ordered_list")
        self.assertEqual([_item_text(i) for i in sub2["children"]], ["Sub-number a", "Sub-number b"])
        # deeper levels keep nesting too
        _, _, third = _find_item(tree, "Third level bullet")
        (sub3,) = _sublists(third)
        self.assertEqual(_item_text(sub3["children"][0]), "Fourth level number")

    def test_start_number_is_kept(self):
        tree = pm.parse(_fixture("14_nested_lists.md"))
        lst, idx, _ = _find_item(tree, "List starting at five")
        self.assertEqual((lst["start"], idx), (5, 0))

    def test_d9_probe(self):
        tree = pm.parse(_fixture("d9_probe.md"))
        # B: "1. First level two / 1. Sub-number a / 2. Sub-number b / 2. First level
        # three". python-markdown flattened this and numbered the last item 4; it is 2.
        lst, idx, _ = _find_item(tree, "First level three")
        self.assertEqual(lst["start"] + idx, 2)
        self.assertEqual(len(lst["children"]), 2)
        b_parent = lst["children"][0]
        self.assertEqual([_item_text(i) for i in _sublists(b_parent)[0]["children"]],
                         ["Sub-number a", "Sub-number b"])
        # A: 3-space bullets under an ordered item
        _, _, a_parent = _find_item(tree, "First level one")
        self.assertEqual(_sublists(a_parent)[0]["type"], "bullet_list")
        # C: 2-space bullets under a bullet nest one level below
        lst_c, _, c_parent = _find_item(tree, "Parent bullet")
        (sub_c,) = _sublists(c_parent)
        self.assertEqual([_item_text(i) for i in sub_c["children"]],
                         ["Child bullet two-space", "Child bullet two-space b"])
        self.assertEqual(len(lst_c["children"]), 2)
        # E: 4-space ordered children
        _, _, e_parent = _find_item(tree, "Clause one")
        self.assertEqual(len(_sublists(e_parent)[0]["children"]), 2)
        # F: start at five
        lst_f, idx_f, _ = _find_item(tree, "Six")
        self.assertEqual(lst_f["start"] + idx_f, 6)


class TaskListAndStrikeTests(unittest.TestCase):
    def test_checked_task(self):
        tree = pm.parse("- [x] Done\n- [ ] Open\n- plain\n")
        items = tree["children"][0]["children"]
        self.assertEqual([i["task"] for i in items], [True, False, None])
        self.assertEqual(_item_text(items[0]), "Done")
        self.assertEqual(_item_text(items[1]), "Open")
        self.assertFalse(any("[x]" in t or "<input" in t for t in _texts(tree)))

    def test_fixture_tasks_including_uppercase_and_nested(self):
        tree = pm.parse(_fixture("15_tasklists.md"))
        tasks = [(i["task"], _item_text(i)) for i in _of_type(tree, "list_item")]
        self.assertEqual(tasks, [(True, "Completed item"), (False, "Open item"),
                                 (True, "Uppercase X done"), (False, "Nested open item")])

    def test_user_written_checkbox_html_is_literal_outside_task_items(self):
        tree = pm.parse('- <input class="task-list-item-checkbox" checked> fake\n')
        item = tree["children"][0]["children"][0]
        self.assertIsNone(item["task"])
        self.assertIn("<input", pm.plain_text(item))

    def test_strikethrough(self):
        tree = pm.parse("~~old~~ new")
        para = tree["children"][0]
        self.assertEqual(para["children"][0], {"type": "strike", "children": [{"type": "text", "value": "old"}]})
        self.assertNotIn("~", pm.plain_text(tree))


class LineBreakTests(unittest.TestCase):
    def test_address_block_keeps_four_lines(self):
        tree = pm.parse("Jane Doe\n123 Main St\nSpringfield, IL 62704\nUSA\n")
        (para,) = tree["children"]
        kinds = [c["type"] for c in para["children"]]
        self.assertEqual(kinds, ["text", "hardbreak", "text", "hardbreak", "text", "hardbreak", "text"])
        self.assertEqual(pm.plain_text(para).split("\n"),
                         ["Jane Doe", "123 Main St", "Springfield, IL 62704", "USA"])

    def test_trailing_spaces_and_backslash_breaks_are_hard_breaks(self):
        tree = pm.parse("a  \nb\\\nc")
        self.assertEqual(pm.plain_text(tree), "a\nb\nc")


class RawHtmlTests(unittest.TestCase):
    def test_br_sub_sup_u_are_nodes(self):
        tree = pm.parse("H<sub>2</sub>O, x<sup>2</sup> and <u>underlined</u><br>next")
        types = [c["type"] for c in tree["children"][0]["children"]]
        self.assertEqual(types, ["text", "sub", "text", "sup", "text", "underline", "hardbreak", "text"])
        self.assertEqual(pm.plain_text(tree), "H2O, x2 and underlined\nnext")

    def test_br_in_a_table_cell(self):
        tree = pm.parse("| Plan | Notes |\n|---|---|\n| Line one<br>Line two | x |\n")
        cell = tree["children"][0]["rows"][0][0]
        self.assertEqual([c["type"] for c in cell], ["text", "hardbreak", "text"])

    def test_img_tag_and_other_html_is_literal_text(self):
        src = '<img src=https://example.com/a.png> and <script>alert(1)</script>'
        tree = pm.parse(src)
        self.assertEqual(_of_type(tree, "image"), [])
        self.assertEqual(pm.plain_text(tree), src)

    def test_html_block_is_literal_with_allowlist(self):
        tree = pm.parse("<Company Address>\n\nNext paragraph.\n")
        self.assertEqual(pm.plain_text(tree["children"][0]), "<Company Address>")
        tree = pm.parse("<div>\nH<sub>2</sub>O\n</div>\n")
        para = tree["children"][0]
        self.assertIn("sub", [c["type"] for c in para["children"]])
        self.assertEqual(pm.plain_text(para), "<div>\nH2O\n</div>")

    def test_unmatched_close_tag_is_literal_and_unclosed_open_runs_to_the_end(self):
        tree = pm.parse("a</u> b <sup>c")
        para = tree["children"][0]["children"]
        self.assertEqual(para[0], {"type": "text", "value": "a</u> b "})
        self.assertEqual(para[1]["type"], "sup")


class LinkAndImageTests(unittest.TestCase):
    def test_links_autolinks_and_bare_urls(self):
        tree = pm.parse(_fixture("17_links.md"))
        links = _of_type(tree, "link")
        self.assertIn("https://example.com/docs?x=1&y=2", [l["href"] for l in links])
        self.assertIn("mailto:support@example.com", [l["href"] for l in links])
        self.assertIn("#section-two", [l["href"] for l in links])
        autos = {a["href"]: a["value"] for a in _of_type(tree, "autolink")}
        self.assertEqual(autos["https://example.com/auto"], "https://example.com/auto")
        self.assertEqual(autos["https://example.com/bare"], "https://example.com/bare")
        headings = _of_type(tree, "heading")
        self.assertIn("section-two", [h["id"] for h in headings])

    def test_no_fuzzy_links_for_file_names(self):
        tree = pm.parse("Edit setup.py and README.md, then mail jane@example.com.")
        self.assertEqual(_of_type(tree, "link"), [])
        self.assertEqual([a["href"] for a in _of_type(tree, "autolink")], ["mailto:jane@example.com"])

    def test_javascript_links_stay_text(self):
        tree = pm.parse("[x](javascript:alert(1))")
        self.assertEqual(_of_type(tree, "link"), [])
        self.assertEqual(pm.plain_text(tree), "[x](javascript:alert(1))")

    def test_image_node(self):
        tree = pm.parse('![Blue *box*](data:image/png;base64,AAAA "T")')
        (img,) = _of_type(tree, "image")
        self.assertEqual(img, {"type": "image", "src": "data:image/png;base64,AAAA", "alt": "Blue box", "title": "T"})

    def test_duplicate_heading_ids_are_unique(self):
        tree = pm.parse("# Intro\n\n## Intro\n\n### Ünïcode Title!\n")
        self.assertEqual([h["id"] for h in _of_type(tree, "heading")], ["intro", "intro-1", "ünïcode-title"])


class MathTests(unittest.TestCase):
    def test_inline_and_block_tex_is_byte_exact(self):
        tree = pm.parse(r"Inline \( E = mc^2 \) and \( a*b*c \) and \( \{x\} \)."
                        "\n\n\\[ \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\]\n")
        self.assertEqual([m["tex"] for m in _of_type(tree, "math_inline")],
                         [" E = mc^2 ", " a*b*c ", r" \{x\} "])
        (block,) = _of_type(tree, "math_block")
        self.assertEqual(block["tex"], r" \begin{pmatrix} a & b \\ c & d \end{pmatrix} ")
        self.assertEqual(_of_type(tree, "em"), [])

    def test_dollars_stay_literal(self):
        tree = pm.parse("Price $5 and $10, $x^2$ and \\$100.\n\n$$\nx\n$$\n")
        self.assertEqual(_of_type(tree, "math_inline") + _of_type(tree, "math_block"), [])
        self.assertIn("Price $5 and $10, $x^2$ and $100.", pm.plain_text(tree))

    def test_display_math_directly_after_a_paragraph_line(self):
        tree = pm.parse("We have\n\\[\nE = mc^2\n\\]\nwhere E is energy.\n")
        self.assertEqual([b["type"] for b in tree["children"]], ["paragraph", "math_block", "paragraph"])
        self.assertEqual(tree["children"][1]["tex"], "\nE = mc^2\n")
        self.assertEqual(pm.plain_text(tree["children"][2]), "where E is energy.")

    def test_mid_line_display_math_gets_its_own_block(self):
        tree = pm.parse("The formula \\[ x^2 + y^2 \\] sits mid paragraph.")
        self.assertEqual([b["type"] for b in tree["children"]], ["paragraph", "math_block", "paragraph"])
        self.assertEqual(pm.plain_text(tree["children"][0]), "The formula")
        self.assertEqual(tree["children"][1]["tex"], " x^2 + y^2 ")
        self.assertEqual(pm.plain_text(tree["children"][2]), "sits mid paragraph.")

    def test_display_math_inside_a_list_item_stays_in_the_item(self):
        tree = pm.parse("1. Compute:\n   \\[ x = 1 \\]\n2. Next\n")
        (lst,) = tree["children"]
        self.assertEqual(lst["type"], "ordered_list")
        self.assertEqual(len(lst["children"]), 2)
        self.assertEqual([c["type"] for c in lst["children"][0]["children"]], ["paragraph", "math_block"])

    def test_display_math_inside_a_blockquote(self):
        tree = pm.parse("> Quote \\[ q \\] end\n")
        (quote,) = tree["children"]
        self.assertEqual([c["type"] for c in quote["children"]], ["paragraph", "math_block", "paragraph"])

    def test_multi_line_math_in_a_blockquote_has_no_quote_markers(self):
        tree = pm.parse("> Quote line\n> \\[\n> q > 1\n> \\]\n> after\n")
        (block,) = _of_type(tree, "math_block")
        self.assertEqual(block["tex"], "\nq > 1\n")

    def test_two_display_maths_in_one_line(self):
        tree = pm.parse("Two \\[ a \\] and \\[ b \\] end.")
        self.assertEqual([b["type"] for b in tree["children"]],
                         ["paragraph", "math_block", "paragraph", "math_block", "paragraph"])
        self.assertEqual(pm.plain_text(tree), "Two\n a \nand\n b \nend.")

    def test_display_math_in_a_table_cell_becomes_inline(self):
        tree = pm.parse("| A | B |\n|---|---|\n| x | \\[ y^2 \\] |\n")
        (table,) = tree["children"]
        self.assertEqual(table["type"], "table")
        self.assertEqual(table["rows"][0][1], [{"type": "math_inline", "tex": " y^2 "}])

    def test_code_is_never_rewritten(self):
        src = "Use `\\[ not math \\]` here.\n\n```\nline \\[ x \\] code\n```\n"
        tree = pm.parse(src)
        self.assertEqual(_of_type(tree, "math_block"), [])
        self.assertEqual(_of_type(tree, "code_inline")[0]["value"], "\\[ not math \\]")
        self.assertEqual(_of_type(tree, "code_block")[0]["value"], "line \\[ x \\] code")

    def test_unclosed_opener_is_left_alone(self):
        tree = pm.parse("Interval \\[0, 1) only.")
        self.assertEqual(_of_type(tree, "math_block"), [])
        self.assertEqual(pm.plain_text(tree), "Interval [0, 1) only.")


class FootnoteAndDeflistTests(unittest.TestCase):
    def test_footnotes(self):
        tree = pm.parse("Text[^a] and again[^a] and other[^b].\n\n[^a]: First.\n[^b]: Second **b**.\n")
        refs = _of_type(tree["children"], "footnote_ref")
        self.assertEqual([r["id"] for r in refs], [0, 0, 1])
        self.assertEqual([f["id"] for f in tree["footnotes"]], [0, 1])
        self.assertEqual(pm.plain_text(tree["footnotes"][1]), "Second b.")

    def test_definition_list(self):
        tree = pm.parse("Term\n: Def one\n\n: Def two\n")
        (dl,) = tree["children"]
        self.assertEqual(dl["type"], "deflist")
        (item,) = dl["children"]
        self.assertEqual(pm.plain_text(item["term"]), "Term")
        self.assertEqual([pm.plain_text(d) for d in item["definitions"]], ["Def one", "Def two"])


class HelperTests(unittest.TestCase):
    def test_first_h1_text(self):
        self.assertEqual(pm.first_h1_text(pm.parse("Intro\n\n#  Quarterly   *Report*\n\n# Second")),
                         "Quarterly Report")
        self.assertIsNone(pm.first_h1_text(pm.parse("## Only h2")))
        # '#Title' is a paragraph in CommonMark
        self.assertIsNone(pm.first_h1_text(pm.parse("#Title")))

    def test_count_table_rows_ignores_code(self):
        md = ("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n"
              "```\n| x | y |\n|---|---|\n| 5 | 6 |\n```\n\n"
              "    | p | q |\n    |---|---|\n    | 7 | 8 |\n\n"
              "> | c |\n> |---|\n> | 9 |\n")
        self.assertEqual(pm.count_table_rows(pm.parse(md)), 3)

    def test_plain_text(self):
        tree = pm.parse("# Title\n\nPara with `code` and \\(x\\).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")
        self.assertEqual(pm.plain_text(tree), "Title\nPara with code and x.\na\tb\n1\t2")

    def test_concurrent_parses_are_independent(self):
        from concurrent.futures import ThreadPoolExecutor

        docs = [f"See https://example.com/{i} and *x{i}*" for i in range(40)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            trees = list(pool.map(pm.parse, docs))
        for i, tree in enumerate(trees):
            self.assertEqual(_of_type(tree, "autolink")[0]["href"], f"https://example.com/{i}")


if __name__ == "__main__":
    unittest.main()
