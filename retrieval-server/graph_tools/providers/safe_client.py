"""An outbound HTTP client hardened for user-configured destinations.

Ordinary HTTP clients are built to reach whatever you point them at. A tool
defined by a customer points somewhere WE did not choose, from a process that
sits inside our network, so the defaults are wrong in specific ways. This
module says no to each of them:

  https only
      A plaintext destination would put the customer's own API key on the wire.

  public addresses only
      Every address the hostname resolves to is checked before the request.
      Loopback, private, link-local, unique-local, reserved and multicast
      ranges are refused. This is what stops a tool from reaching cloud
      instance metadata (169.254.169.254), a sidecar, or anything else on the
      private network this process can see.

  no redirects
      A 302 is an attacker-controlled destination that would otherwise bypass
      every check above, and it would replay the customer's credential to
      wherever it pointed. Redirects are surfaced to the model as the response.

  bounded time and size
      A slow or enormous response would otherwise occupy a worker and blow out
      the model's context. Both are capped.

  no caller-controlled transport headers
      Host, Content-Length and the hop-by-hop headers are ours to set.

KNOWN LIMITATION, stated plainly for the security review: validation happens on
the addresses resolved just before the request, so a hostname whose DNS record
changes between that check and the connection (a DNS rebinding attack) is not
fully prevented. Closing it requires pinning the connection to the validated
address while preserving TLS verification against the hostname, which is worth
doing when this tier accepts arbitrary user-supplied URLs. Until then the
destination host is fixed when the tool is defined and cannot be influenced by
a model argument, which is what bounds the exposure.
"""
import ipaddress
import logging
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

ALLOWED_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})

DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024

# Headers the caller may not set: transport-level concerns we own, plus the
# hop-by-hop set, which has no meaning end-to-end.
_RESERVED_HEADERS = frozenset({
    "host", "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailer", "upgrade", "expect",
})


class UnsafeRequestError(ValueError):
    """The request was refused before anything left the process."""


class ResponseTooLargeError(ValueError):
    """The response exceeded the byte cap and was abandoned."""


@dataclass
class HttpResponse:
    status_code: int
    headers: dict
    text: str
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300


def _is_public_address(ip: str) -> bool:
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # is_global is the closest single predicate, but it is permissive about
    # some reserved space, so the specific rejections are spelled out too.
    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # An IPv4-mapped v6 address (::ffff:169.254.169.254) must be judged on
        # the address it actually reaches.
        if address.ipv4_mapped is not None:
            return _is_public_address(str(address.ipv4_mapped))
        if address.sixtofour is not None:
            return _is_public_address(str(address.sixtofour))
    return True


def resolve_public_addresses(host: str, port: int) -> list[str]:
    """Every address `host` resolves to, if they are ALL public.

    All-or-nothing on purpose: a hostname with one public and one private
    record would otherwise be a coin flip at connection time.
    """
    if not host:
        raise UnsafeRequestError("Request has no host")
    # A bare IP literal is checked directly rather than resolved.
    try:
        ipaddress.ip_address(host.strip("[]"))
        candidates = [host.strip("[]")]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror as e:
            raise UnsafeRequestError(f"Could not resolve host '{host}'") from e
        candidates = sorted({info[4][0] for info in infos})

    if not candidates:
        raise UnsafeRequestError(f"Host '{host}' resolved to no addresses")
    unsafe = [ip for ip in candidates if not _is_public_address(ip)]
    if unsafe:
        raise UnsafeRequestError(
            f"Host '{host}' resolves to a non-public address and cannot be called"
        )
    return candidates


def validate_url(url: str) -> tuple[str, int]:
    """Check scheme and host reachability. Returns (host, port)."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise UnsafeRequestError(
            f"Only https URLs are allowed (got '{parts.scheme or 'no scheme'}')"
        )
    if not parts.hostname:
        raise UnsafeRequestError("URL has no host")
    port = parts.port or 443
    resolve_public_addresses(parts.hostname, port)
    return parts.hostname, port


def sanitize_headers(headers: dict) -> dict:
    """Drop headers the caller may not set, and reject header injection."""
    clean: dict[str, str] = {}
    for name, value in (headers or {}).items():
        lowered = str(name).lower()
        if lowered in _RESERVED_HEADERS:
            logger.warning("Dropping reserved header '%s' from a tool request", name)
            continue
        text = "" if value is None else str(value)
        if "\n" in text or "\r" in text or "\n" in str(name) or "\r" in str(name):
            raise UnsafeRequestError(
                f"Header '{name}' contains a newline and would allow header injection"
            )
        clean[str(name)] = text
    return clean


async def request(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    params: dict | None = None,
    json_body=None,
    form_body: dict | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> HttpResponse:
    """Perform one validated request. Raises UnsafeRequestError before any
    network activity when the destination is not allowed."""
    import httpx

    upper = (method or "").upper()
    if upper not in ALLOWED_METHODS:
        raise UnsafeRequestError(f"HTTP method '{method}' is not allowed")

    validate_url(url)
    safe_headers = sanitize_headers(headers or {})

    kwargs = {}
    if json_body is not None:
        kwargs["json"] = json_body
    elif form_body is not None:
        kwargs["data"] = form_body

    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,  # see the module docstring
        max_redirects=0,
    ) as client:
        async with client.stream(
            upper, url, headers=safe_headers, params=params or None, **kwargs
        ) as response:
            chunks: list[bytes] = []
            total = 0
            truncated = False
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    chunks.append(chunk[: max_bytes - (total - len(chunk))])
                    truncated = True
                    break
                chunks.append(chunk)
            body = b"".join(chunks)

    encoding = response.encoding or "utf-8"
    try:
        text = body.decode(encoding, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")

    return HttpResponse(
        status_code=response.status_code,
        headers=dict(response.headers),
        text=text,
        truncated=truncated,
    )
