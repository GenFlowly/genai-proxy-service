"""
Unit tests for graph_tools.providers.template.

Run with `python -m unittest tests.test_tool_template`.

`args` values are model-controlled, and a user can steer the model by pasting
text into a chat. So most of what follows is adversarial: the question each
test asks is "can a hostile argument value change the shape of the request,
rather than just its content?"
"""
import unittest

from graph_tools.providers.template import (
    TemplateError,
    arg_names,
    has_placeholder,
    render,
    render_body,
    render_mapping,
    placeholders,
)


class ParsingTests(unittest.TestCase):
    def test_finds_both_namespaces(self):
        found = placeholders("{{args.id}}/{{credential.api_key}}")
        self.assertEqual(found, {("args", "id"), ("credential", "api_key")})

    def test_tolerates_inner_whitespace(self):
        self.assertEqual(placeholders("{{ args.id }}"), {("args", "id")})

    def test_arg_names_ignores_credentials(self):
        self.assertEqual(arg_names("{{args.a}}{{credential.b}}"), {"a"})

    def test_has_placeholder_detects_malformed_ones(self):
        self.assertTrue(has_placeholder("{{nope.x}}"))
        self.assertFalse(has_placeholder("plain text"))


class RenderTests(unittest.TestCase):
    def test_substitutes_both_namespaces(self):
        out = render("{{args.id}}:{{credential.key}}", {"id": "7"}, {"key": "sk"})
        self.assertEqual(out, "7:sk")

    def test_preserves_surrounding_literal_text(self):
        out = render("Bearer {{credential.key}}", {}, {"key": "sk-1"})
        self.assertEqual(out, "Bearer sk-1")

    def test_numbers_and_booleans_stringify_for_http(self):
        self.assertEqual(render("{{args.n}}", {"n": 42}, {}), "42")
        self.assertEqual(render("{{args.b}}", {"b": True}, {}), "true")
        self.assertEqual(render("{{args.b}}", {"b": False}, {}), "false")

    def test_missing_argument_is_an_error_not_an_empty_string(self):
        # The failure mode this prevents: "Bearer " going out on the wire.
        with self.assertRaises(TemplateError):
            render("{{args.missing}}", {}, {})

    def test_missing_credential_is_an_error(self):
        with self.assertRaises(TemplateError):
            render("{{credential.api_key}}", {}, {})

    def test_none_valued_argument_is_an_error(self):
        with self.assertRaises(TemplateError):
            render("{{args.id}}", {"id": None}, {})

    def test_credential_error_does_not_name_the_stored_keys(self):
        with self.assertRaises(TemplateError) as ctx:
            render("{{credential.api_key}}", {}, {"other_secret_name": "x"})
        self.assertNotIn("other_secret_name", str(ctx.exception))

    def test_unknown_namespace_is_rejected_rather_than_passed_through(self):
        with self.assertRaises(TemplateError):
            render("{{env.HOME}}", {}, {})

    def test_malformed_placeholder_is_rejected(self):
        with self.assertRaises(TemplateError):
            render("{{args.}}", {"": "x"}, {})


class SubstitutionIsNotEvaluationTests(unittest.TestCase):
    """A substituted value is data. It is never scanned again."""

    def test_a_value_containing_a_placeholder_is_not_re_substituted(self):
        # Otherwise a model-supplied argument could exfiltrate a credential by
        # containing the text "{{credential.api_key}}".
        with self.assertRaises(TemplateError):
            render("{{args.q}}", {"q": "{{credential.api_key}}"}, {"api_key": "sk-secret"})

    def test_the_credential_never_appears_when_that_attack_is_attempted(self):
        try:
            out = render("{{args.q}}", {"q": "{{credential.api_key}}"}, {"api_key": "sk-secret"})
        except TemplateError as e:
            out = str(e)
        self.assertNotIn("sk-secret", out)


class PathEncodingTests(unittest.TestCase):
    """encode=True is used for URL path segments, where an unencoded value
    could escape its segment."""

    def test_slash_is_encoded(self):
        out = render("/issues/{{args.id}}", {"id": "a/b"}, {}, encode=True)
        self.assertEqual(out, "/issues/a%2Fb")

    def test_dot_dot_cannot_traverse(self):
        out = render("/issues/{{args.id}}", {"id": "../../admin"}, {}, encode=True)
        self.assertNotIn("../", out.split("/issues/")[1])

    def test_query_and_fragment_characters_are_encoded(self):
        out = render("/s/{{args.q}}", {"q": "x?a=1#frag"}, {}, encode=True)
        self.assertNotIn("?", out)
        self.assertNotIn("#", out)

    def test_an_absolute_url_in_an_argument_cannot_replace_the_path(self):
        out = render("/s/{{args.q}}", {"q": "https://evil.example.com/x"}, {}, encode=True)
        self.assertNotIn("//evil.example.com", out)

    def test_literal_parts_of_the_template_are_never_encoded(self):
        out = render("/a/b/{{args.id}}", {"id": "1"}, {}, encode=True)
        self.assertEqual(out, "/a/b/1")

    def test_encoding_is_off_by_default_for_headers_and_bodies(self):
        out = render("{{args.q}}", {"q": "a b/c"}, {})
        self.assertEqual(out, "a b/c")


class RenderMappingTests(unittest.TestCase):
    def test_renders_values(self):
        out = render_mapping({"Authorization": "Bearer {{credential.k}}"}, {}, {"k": "sk"})
        self.assertEqual(out, {"Authorization": "Bearer sk"})

    def test_empty_and_none_are_safe(self):
        self.assertEqual(render_mapping(None, {}, {}), {})
        self.assertEqual(render_mapping({}, {}, {}), {})

    def test_header_names_cannot_be_templated(self):
        # A templated name would let a model-supplied value introduce an
        # arbitrary header.
        with self.assertRaises(TemplateError):
            render_mapping({"{{args.h}}": "v"}, {"h": "X-Evil"}, {})


class RenderBodyTests(unittest.TestCase):
    def test_renders_nested_values(self):
        out = render_body({"a": {"b": "{{args.x}}"}}, {"x": "1"}, {})
        self.assertEqual(out, {"a": {"b": "1"}})

    def test_a_lone_placeholder_keeps_the_value_type(self):
        # So a numeric argument stays a number an API will accept.
        out = render_body({"limit": "{{args.n}}"}, {"n": 10}, {})
        self.assertEqual(out["limit"], 10)
        self.assertIsInstance(out["limit"], int)

    def test_a_placeholder_with_surrounding_text_becomes_a_string(self):
        out = render_body({"q": "id:{{args.n}}"}, {"n": 10}, {})
        self.assertEqual(out["q"], "id:10")

    def test_lists_are_rendered_elementwise(self):
        out = render_body({"ids": ["{{args.a}}", "{{args.b}}"]}, {"a": 1, "b": 2}, {})
        self.assertEqual(out["ids"], [1, 2])

    def test_non_string_leaves_pass_through(self):
        out = render_body({"n": 5, "b": True, "z": None}, {}, {})
        self.assertEqual(out, {"n": 5, "b": True, "z": None})

    def test_none_body_stays_none(self):
        self.assertIsNone(render_body(None, {}, {}))

    def test_body_keys_cannot_be_templated(self):
        with self.assertRaises(TemplateError):
            render_body({"{{args.k}}": "v"}, {"k": "evil"}, {})

    def test_missing_argument_in_a_body_is_an_error(self):
        with self.assertRaises(TemplateError):
            render_body({"a": "{{args.nope}}"}, {}, {})


if __name__ == "__main__":
    unittest.main()
