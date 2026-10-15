# Code

Inline `some_function(argument_one, argument_two)` in text.

```python
def handler(request):  # a very long line follows
    result = some_service.call_with_many_arguments(customer_id=request.customer_id, conversation_id=request.conversation_id, include_attachments=True, max_tokens=4096, temperature=0.2)
    if result:
        return {"status": "ok", "payload": result}
```

```
SELECT customer_id, COUNT(*) AS n, SUM(amount) AS total, AVG(amount) AS mean FROM orders WHERE created_at >= '2026-01-01' AND status IN ('paid','shipped','delivered') GROUP BY customer_id ORDER BY total DESC;
https://example.com/a/very/long/url/without/any/spaces/that/cannot/be/wrapped/at/all/because/it/is/one/token/abcdefghijklmnop
```

    indented code block
        with nesting	and a tab
