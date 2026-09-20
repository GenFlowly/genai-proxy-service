/**
 * Shared router worker for the genflowly domains.
 *
 * Routes requests by URL path: /api goes to the backend API, everything
 * else to the static site on Cloudflare Pages. This one source serves all
 * four routers (react app + admin panel, dev + prod); the hostnames come
 * from per-environment vars in react-app.toml and admin-panel.toml.
 */

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

    return response;
  },
};
