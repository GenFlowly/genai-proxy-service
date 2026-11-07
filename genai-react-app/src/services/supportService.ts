import { config } from '../config/env'

export const SUPPORT_TOPICS = ['account', 'billing', 'bug', 'feature', 'privacy', 'other'] as const
export type SupportTopic = typeof SUPPORT_TOPICS[number]

export const isSupportTopic = (value: string | null | undefined): value is SupportTopic =>
    !!value && (SUPPORT_TOPICS as readonly string[]).includes(value)

export interface SupportRequest {
    name: string
    email: string
    topic: SupportTopic
    message: string
    /** A field hidden from people; only bots fill it in. */
    website: string
    context: {
        source: 'web' | 'ios'
        appVersion?: string
        page?: string
        customerId?: string
    }
}

export class SupportRequestError extends Error {
    constructor(message: string, readonly status: number, readonly fields: string[] = []) {
        super(message)
        this.name = 'SupportRequestError'
    }
}

/**
 * Sends the support form and resolves to the request's ID. Never retried:
 * a second attempt would email the support inbox twice.
 */
export async function sendSupportRequest(request: SupportRequest): Promise<string> {
    const url = config.support.requestUrl
    if (!url) throw new SupportRequestError('This build has no support API URL', 0)

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
        const fields = Array.isArray(data?.fields) ? data.fields.filter((f: unknown) => typeof f === 'string') : []
        throw new SupportRequestError(`Support request failed: ${response.status}`, response.status, fields)
    }
    return typeof data?.requestId === 'string' ? data.requestId : ''
}
