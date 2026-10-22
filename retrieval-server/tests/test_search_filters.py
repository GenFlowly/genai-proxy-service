"""Row-filter selection for unified /search: customer partition by default,
group-key allow-list for types whose access control the caller owns."""
from encoding_library.utils.vector_db import customer_filter

from routes.search import SearchRequest, _row_filter


def _req(**kwargs) -> SearchRequest:
    return SearchRequest(customer_id="CU-1", query="how do I write tests", **kwargs)


def test_defaults_to_customer_scope():
    assert _row_filter(_req(), "instructions") == customer_filter("CU-1")


def test_allow_listed_type_matches_by_group_key():
    req = _req(allowed_keys={"instructions": ["INS-1", "INS-2"]})
    assert _row_filter(req, "instructions") == 'instruction_key in ["INS-1", "INS-2"]'


def test_types_outside_the_allow_list_keep_customer_scope():
    req = _req(allowed_keys={"instructions": ["INS-1"]})
    assert _row_filter(req, "conversation") == customer_filter("CU-1")


def test_empty_allow_list_skips_the_collection():
    # Caller can access nothing of this type: no filter at all (skip), never
    # a fall-through to customer scope.
    assert _row_filter(_req(allowed_keys={"instructions": []}), "instructions") is None


def test_type_without_group_field_cannot_be_key_filtered():
    # email rows group by row id, not a group field — an allow-list on them
    # must skip rather than silently widen to customer scope.
    assert _row_filter(_req(allowed_keys={"email": ["msg-1"]}), "email") is None


def test_keys_are_escaped_for_the_filter_expression():
    req = _req(allowed_keys={"instructions": ['a"b\\c']})
    assert _row_filter(req, "instructions") == 'instruction_key in ["a\\"b\\\\c"]'
