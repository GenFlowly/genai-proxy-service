/**
 * Server-side proxy for `POST /api/v1/voice/models` so the developer API key
 * never reaches the browser. Returns the realtime voice models available to
 * the customer, grouped by vendor.
 */
export async function GET() {
  const proxyUrl = (process.env.GENFLOWLY_PROXY_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
  const apiKey = process.env.GENFLOWLY_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'GENFLOWLY_API_KEY is not set (see .env.example)' }, { status: 500 })
  }

  let res: globalThis.Response
  try {
    res = await fetch(`${proxyUrl}/api/v1/voice/models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ aiVendor: ['OPENAI', 'GEMINI'] }),
      cache: 'no-store',
    })
  } catch (e) {
    return Response.json({ error: `Cannot reach genai-proxy-server at ${proxyUrl}: ${e}` }, { status: 502 })
  }

  if (!res.ok) {
    const body = await res.text()
    return Response.json(
      { error: `voice/models failed with ${res.status}: ${body || res.statusText}` },
      { status: res.status }
    )
  }

  const data: { aiVendorModelList: { aiVendor: string; modelsList: string[] }[] } = await res.json()
  return Response.json(data)
}
