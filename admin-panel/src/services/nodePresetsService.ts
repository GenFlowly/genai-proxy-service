import { endpoints } from '../config/endpoints'
import {
    ListNodePresetsResponse,
    NodePresetPayload,
    NodePresetResponse,
} from '../models/nodePresets.models'

/**
 * Like the default-graph assertOk: surfaces the backend's validation reason on
 * 400 responses (invalid config JSON, unknown instruction_id) instead of a
 * bare status line.
 */
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

/** All pre-made node presets, sorted by the backend (sortOrder). Customer auth. */
export async function getNodePresets(token: string): Promise<ListNodePresetsResponse> {
    const response = await fetch(endpoints.nodePresets, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading node presets')
    return response.json()
}

export async function createNodePreset(
    token: string,
    payload: NodePresetPayload
): Promise<NodePresetResponse> {
    const response = await fetch(endpoints.adminNodePresets, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Creating node preset "${payload.name}"`)
    return response.json()
}

export async function updateNodePreset(
    token: string,
    presetId: string,
    payload: NodePresetPayload
): Promise<NodePresetResponse> {
    const response = await fetch(endpoints.adminNodePreset(presetId), {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Updating node preset ${presetId}`)
    return response.json()
}

export async function deleteNodePreset(token: string, presetId: string): Promise<void> {
    const response = await fetch(endpoints.adminNodePreset(presetId), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, `Deleting node preset ${presetId}`)
}
