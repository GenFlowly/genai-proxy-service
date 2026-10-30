"""Metric label sanitization and cardinality bounding (metrics._bound_value
via the public count/observe API against the prometheus backend)."""
import pytest

prometheus_client = pytest.importorskip("prometheus_client")

from encoding_library.observability import count, observe
from encoding_library.observability import metrics


@pytest.fixture(autouse=True)
def _prometheus_backend_and_fresh_tracking():
    metrics.configure_observability(service="test", backend="prometheus")
    with metrics._lock:
        metrics._label_values_seen.clear()
    yield


def _counter_value(name, **labels):
    return prometheus_client.REGISTRY.get_sample_value(
        name, {"service": "test", **labels})


def test_control_characters_stripped():
    count("lb_ctrl_total", model="bad\nmodel\x00\x1bname")
    assert _counter_value("lb_ctrl_total", model="badmodelname") == 1


def test_long_values_truncated_to_64():
    long_value = "m" * 300
    count("lb_trunc_total", model=long_value)
    assert _counter_value("lb_trunc_total", model="m" * 64) == 1
    assert _counter_value("lb_trunc_total", model=long_value) is None
    assert metrics.LABEL_VALUE_MAX_LENGTH == 64


def test_non_string_values_coerced():
    count("lb_coerce_total", model=123)
    count("lb_coerce_total", model=None)
    assert _counter_value("lb_coerce_total", model="123") == 1
    assert _counter_value("lb_coerce_total", model="") == 1


def test_cardinality_cap_replaces_new_values_with_other():
    cap = metrics.MAX_LABEL_VALUES
    assert cap == 50
    for i in range(cap + 5):
        count("lb_cap_total", tool=f"tool-{i}")

    assert _counter_value("lb_cap_total", tool="tool-0") == 1
    assert _counter_value("lb_cap_total", tool=f"tool-{cap - 1}") == 1
    assert _counter_value("lb_cap_total", tool=f"tool-{cap}") is None
    assert _counter_value("lb_cap_total", tool="other") == 5

    count("lb_cap_total", tool="tool-3")
    assert _counter_value("lb_cap_total", tool="tool-3") == 2

    count("lb_cap_vendor_total", vendor="brand-new-vendor")
    assert _counter_value("lb_cap_vendor_total",
                          vendor="brand-new-vendor") == 1

    with metrics._lock:
        assert len(metrics._label_values_seen["tool"]) <= cap + 1


def test_disallowed_dimension_dropped():
    count("lb_filter_total", model="m1", customer_id="cust-42")
    assert _counter_value("lb_filter_total", model="m1") == 1
    sanitized = metrics._clean({"model": "m1", "customer_id": "cust-42"})
    assert "customer_id" not in sanitized
    assert sanitized["model"] == "m1"


def test_hostile_values_never_raise():
    count("lb_hostile_total", model=None)
    count("lb_hostile_total", model="x" * 10_240)
    count("lb_hostile_total", model="a\nb\r\nc\x00d")
    count("lb_hostile_total", tool=object())
    observe("lb_hostile_duration_seconds", 0.1, model="\x00\x01\x02")
    assert _counter_value("lb_hostile_duration_seconds_count",
                          model="") == 1
