/**
 * Cloudflare Worker for the DEVELOPMENT admin panel.
 * Routes requests by URL path: /api goes to the backend (Fly/ELB behind
 * api-development.genflowly.com), everything else to the admin panel's
 * Cloudflare Pages site. Mirrors the genai-react-app worker.
 *
 * Attach this worker to the admin panel's dev domain (e.g.
 * admin-development.genflowly.com) via a Workers route or custom domain.
 */

const ELB_ENDPOINT = 'api-development.genflowly.com';
// Branch alias of the development deployment on the genflowly-admin-panel
// Pages project (dev deploys run `wrangler pages deploy --branch=development`).
const PAGES_ENDPOINT = 'development.genflowly-admin-panel.pages.dev';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ✅ Handle CORS preflight at the edge
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

    const targetUrl = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      // Route /api requests to the backend
      targetUrl.hostname = ELB_ENDPOINT;
    } else {
      // Route everything else to Cloudflare Pages
      targetUrl.hostname = PAGES_ENDPOINT;
    }

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

    // ✅ Add CORS headers to API responses
    if (url.pathname.startsWith("/api")) {
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
