import base64

import pytest

from encoding_library.utils import vendor_keys


class FakeTable:
    def __init__(self, items):
        self.items = items
        self.requested_keys = []

    def get_item(self, Key):
        self.requested_keys.append(Key)
        item = self.items.get((Key["customerId"], Key["aiVendor"]))
        return {"Item": item} if item else {}


class FakeDynamo:
    def __init__(self, table):
        self.table = table

    def Table(self, name):
        return self.table


class FakeKMS:
    def decrypt(self, CiphertextBlob):
        return {"Plaintext": b"decrypted:" + CiphertextBlob}


def _install(monkeypatch, items):
    table = FakeTable(items)
    monkeypatch.setattr(vendor_keys, "_clients", lambda: (FakeDynamo(table), FakeKMS()))
    return table


def _encrypted(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def test_hf_token_decrypts_stored_row(monkeypatch):
    _install(monkeypatch, {("CU1", "HUGGINGFACE"): {"apiKey": _encrypted("hf-raw")}})
    assert vendor_keys.get_customer_hf_token("CU1") == "decrypted:hf-raw"


def test_hf_token_missing_row_returns_none(monkeypatch):
    _install(monkeypatch, {})
    assert vendor_keys.get_customer_hf_token("CU1") is None


def test_hf_token_store_failure_degrades_to_none(monkeypatch):
    def broken():
        raise RuntimeError("dynamo unreachable")

    monkeypatch.setattr(vendor_keys, "_clients", broken)
    assert vendor_keys.get_customer_hf_token("CU1") is None


def test_embedding_key_store_failure_still_propagates(monkeypatch):
    def broken():
        raise RuntimeError("dynamo unreachable")

    monkeypatch.setattr(vendor_keys, "_clients", broken)
    with pytest.raises(RuntimeError):
        vendor_keys.get_customer_embedding_key("CU1", "voyage")


def test_embedding_key_vendor_mapping(monkeypatch):
    table = _install(
        monkeypatch, {("CU1", "VOYAGE"): {"apiKey": _encrypted("pa-raw")}}
    )
    assert vendor_keys.get_customer_embedding_key("CU1", "voyage") == "decrypted:pa-raw"
    assert table.requested_keys == [{"customerId": "CU1", "aiVendor": "VOYAGE"}]
    assert vendor_keys.get_customer_embedding_key("CU1", "sentence-transformer") is None
