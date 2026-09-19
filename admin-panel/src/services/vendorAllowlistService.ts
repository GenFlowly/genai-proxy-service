import { endpoints } from '../config/endpoints'

export interface VendorAllowlistEntry {
    /** Provider catalog id (LiteLLM id, e.g. "openai", "xai") */
    id: string
    displayName: string
    /** First-party langchain integration vs LiteLLM path */
    native: boolean
    allowed: boolean
}

export interface GetVendorAllowlistResponse {
    vendors: VendorAllowlistEntry[]
    /** False until an admin has saved the list at least once (= all allowed) */
    configured: boolean
}

async function assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) return
    if (response.status === 403) {
        throw new Error('Admin access required — your account is not on the admin allowlist.')
    }
    if (response.status === 400) {
        const reason = await response
            .json()
            .then((body) => body?.error as string | undefined)
            .catch(() => undefined)
        if (reason) throw new Error(reason)
    }
    throw new Error(`${action} failed: ${response.status} ${response.statusText}`)
}

export async function getVendorAllowlist(token: string): Promise<GetVendorAllowlistResponse> {
    const response = await fetch(endpoints.vendorAllowlist, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading vendor allowlist')
    return response.json()
}

export async function putVendorAllowlist(token: string, allowedVendors: string[]): Promise<void> {
    const response = await fetch(endpoints.vendorAllowlist, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allowedVendors }),
    })
    await assertOk(response, 'Saving vendor allowlist')
}
