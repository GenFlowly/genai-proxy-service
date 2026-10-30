# DRAFT — upstream issue for voyageai-python (not yet filed)

File at: https://github.com/voyage-ai/voyageai-python/issues

---

**Title:** `functools.lru_cache` on `BaseClient.tokenizer` pins every Client instance (and a ~31 MB tokenizer each) for the process lifetime

## Summary

`voyageai/_base.py` decorates an **instance method** with `functools.lru_cache()`:

```python
@functools.lru_cache()
def tokenizer(self, model: str):
    ...
    tokenizer = Tokenizer.from_pretrained(f"voyageai/{model}")
```

`lru_cache` on a method keys its (class-level, shared) cache by `(self, model)`. Two consequences:

1. **Every `Client`/`AsyncClient` instance that ever tokenizes is retained forever** (strongly referenced as a cache key) — the client itself, its session, and its own ~31 MB Rust `tokenizers.Tokenizer` object are never garbage-collected.
2. With the default `maxsize=128`, the cache can retain up to **~4 GB** of tokenizers in a process that constructs clients dynamically (e.g. one client per tenant/API key in a multi-tenant service).

The embed path hits `tokenizer()` on every call (token counting before the HTTP request), so a service that constructs a fresh client per request leaks ~31 MB **per embed call**. We measured this in production (an OOM-kill loop on a 2 GB VM) and in isolation: 120 fresh-client `embed_query` calls retained 3.67 GB (python:3.11-slim, voyageai 0.5.0, tokenizers 0.22).

## Reproduction

```python
# pip install langchain-voyageai  (or use voyageai.Client directly)
import gc

def rss_mb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024

import voyageai

base = rss_mb()
for i in range(1, 121):
    c = voyageai.Client(api_key="pa-fake")   # fresh client, as a per-request pattern would
    try:
        c.embed(["a"], model="voyage-3.5")   # tokenizer loads+pins BEFORE the HTTP 401
    except Exception:
        pass
    del c
    if i % 30 == 0:
        gc.collect()
        print(f"iter {i}: +{rss_mb() - base:.0f} MB")
# observed: +955 MB @30, +1859 @60, +2770 @90, +3670 @120 — linear, never reclaimed
```

## Suggested fix

Cache the tokenizer per **model only**, at module level, so it is shared across client instances and loaded once per process:

```python
@functools.lru_cache(maxsize=8)
def _load_tokenizer(model: str):
    tokenizer = Tokenizer.from_pretrained(f"voyageai/{model}")
    tokenizer.no_truncation()
    return tokenizer

class BaseClient:
    def tokenizer(self, model: str):
        return _load_tokenizer(model)
```

(The tokenizer does not depend on any client state, so there is no reason for `self` to participate in the cache key. `flake8-bugbear` B019 flags exactly this pattern.)

## Environment

- voyageai 0.5.0, tokenizers 0.22.2, Python 3.11, Linux x86_64
