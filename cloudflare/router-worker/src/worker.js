/**
 * Shared router worker for the genflowly domains.
 *
 * Routes requests by URL path: /api goes to the backend API, everything
 * else to the static site on Cloudflare Pages. This one source serves all
 * four routers (react app + admin panel, dev + prod); the hostnames come
 * from per-environment vars in react-app.toml and admin-panel.toml.
 *
 * For the react app (CONVERSATION_PREVIEWS="true"), /chat/:id pages get
 * their <title> and og:title rewritten with the real conversation title so
 * link unfurls (iMessage, Slack, ...) show it instead of the hardcoded
 * index.html title. The title comes from the unauthenticated /chat/meta
 * endpoint, which only answers for publicly shared conversations — private
 * ones 403 and keep the generic title.
 */

const CHAT_PATH_RE =
  /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Title of a publicly shared conversation, or null for anything else
 * (private, unknown, no title yet, API slow/down). Never throws — a
 * failed lookup must degrade to the generic HTML, not break the page.
 */
async function fetchPublicConversationTitle(conversationId, env) {
  try {
    const res = await fetch(
      `https://${env.API_HOST}/api/v1/chat/meta?conversationId=${conversationId}`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) return null;
    const meta = await res.json();
    return typeof meta.title === "string" && meta.title.trim() ? meta.title : null;
  } catch (e) {
    console.log({ conversationMetaLookupFailed: String(e) });
    return null;
  }
}

function withConversationTitle(response, title, pageUrl) {
  return new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(`${title} | Genflowly`);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute("content", title);
      },
    })
    .on("head", {
      element(el) {
        el.append(
          `<meta property="og:url" content="${pageUrl.origin}${pageUrl.pathname}" />`,
          { html: true }
        );
      },
    })
    .transform(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight at the edge
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const isApi = url.pathname.startsWith("/api");
    const targetUrl = new URL(request.url);
    targetUrl.hostname = isApi ? env.API_HOST : env.STATIC_HOST;

    console.log({
      incoming: url.pathname,
      outgoing: targetUrl.toString(),
    });

    // Kick off the title lookup before fetching the page so the two run in
    // parallel and the rewrite adds no extra latency.
    const chatMatch =
      !isApi && env.CONVERSATION_PREVIEWS === "true" && request.method === "GET"
        ? url.pathname.match(CHAT_PATH_RE)
        : null;
    const titlePromise = chatMatch
      ? fetchPublicConversationTitle(chatMatch[1], env)
      : null;

    const response = await fetch(
      new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      })
    );

    // Add CORS headers to API responses
    if (isApi) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    if (titlePromise) {
      const title = await titlePromise;
      const contentType = response.headers.get("content-type") || "";
      if (title && contentType.includes("text/html")) {
        return withConversationTitle(response, title, url);
      }
    }

    return response;
  },
};
