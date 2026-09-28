import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'

// Mirrors genai-proxy-server models/api/CustomerTool.kt and the CustomerTools
// table contract. The four structured fields (parameters, request,
// responseTransform) travel as JSON strings, exactly as they are stored.

/** Only `active` tools are ever bound to an agent. */
export type CustomerToolStatus = 'draft' | 'active' | 'disabled'

export type CustomerToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export const TOOL_METHODS: CustomerToolMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** Argument types the restricted schema allows — no nesting, no arrays. */
export type ToolArgumentType = 'string' | 'number' | 'integer' | 'boolean'

export const TOOL_ARGUMENT_TYPES: ToolArgumentType[] = ['string', 'number', 'integer', 'boolean']

export type ResponseTransformMode = 'text' | 'json' | 'json_path'

export const RESPONSE_TRANSFORM_MODES: ResponseTransformMode[] = ['text', 'json', 'json_path']

export interface ToolSchemaProperty {
    type: ToolArgumentType
    description?: string
    enum?: string[]
}

/** The restricted JSON Schema object stored in `parameters`. */
export interface ToolParametersSchema {
    type: 'object'
    properties: Record<string, ToolSchemaProperty>
    required: string[]
}

/** The call template stored in `request`. */
export interface ToolRequestTemplate {
    method: CustomerToolMethod
    url: string
    headers: Record<string, string>
    query: Record<string, string>
    /** null = no body; ignored for methods that cannot carry one */
    body: Record<string, string> | null
    bodyType: 'json' | 'form'
}

export interface ToolResponseTransform {
    mode: ResponseTransformMode
    /** Dotted path, `json_path` mode only. Integer segments index lists. */
    path?: string
    maxChars?: number
}

export interface CustomerTool {
    name: string
    description: string
    /** JSON string: ToolParametersSchema */
    parameters: string
    /** The seam value; `http` today */
    provider: string
    /** JSON string: ToolRequestTemplate */
    request: string
    /** Key into the customer's stored credentials, or "" */
    credentialRef: string
    /** JSON string: ToolResponseTransform */
    responseTransform: string
    status: CustomerToolStatus
    version: number
    origin: string
    originRef: string
    /** ISO-8601; non-empty is what lets a tool leave `draft` */
    lastDryRunAt: string
    createdAt?: string | null
    updatedAt?: string | null
}

export interface UpsertCustomerToolRequest {
    name: string
    description: string
    parameters: string
    provider: string
    request: string
    credentialRef: string
    responseTransform: string
    status: CustomerToolStatus
    origin: string
    originRef: string
    /** Carried back on save: `active` is refused while this is empty */
    lastDryRunAt: string
}

export interface ListCustomerToolsResponse {
    tools: CustomerTool[]
}

// Mirrors genai-proxy-server models/api/ToolCredentialStatus.kt

export interface ToolCredentialStatus {
    toolType: string
    authType: string
    connected: boolean
    connectedAt?: string | null
}

export interface GetToolCredentialStatusListResponse {
    toolCredentialStatuses: ToolCredentialStatus[]
}

export interface StoreToolCredentialsRequest {
    toolType: string
    authType: string
    credentials: Record<string, string>
}

export interface StoreToolCredentialsResponse {
    toolCredentialStatus: ToolCredentialStatus
}

/** The request the platform resolved and sent, per the dry run. */
export interface DryRunResolvedRequest {
    method: string
    url: string
    headers: Record<string, string>
    query: Record<string, string>
    /** The body as sent, or null when the call carries none */
    body?: unknown
}

/** What the upstream API answered. */
export interface DryRunHttpResponse {
    status_code: number
    /** Raw response body, already truncated by the server */
    body: string
    truncated: boolean
}

/** Field names are the runtime's, so the editor reads the runtime's payload. */
export interface DryRunResult {
    ok: boolean
    request?: DryRunResolvedRequest | null
    response?: DryRunHttpResponse | null
    /** The exact text the model would receive, after the response transform */
    model_sees?: string | null
    error?: string | null
}

export interface DryRunCustomerToolRequest {
    /** The definition to test; omit to test the stored tool of that name */
    tool?: UpsertCustomerToolRequest
    /** Sample arguments, typed as the model would supply them */
    args: Record<string, unknown>
}

/** The only `provider` value Phase 1 writes. */
export const HTTP_PROVIDER = 'http'

/** Tools built by hand in this page, as opposed to imported from a spec. */
export const MANUAL_ORIGIN = 'manual'

/** Server-side name rule, mirrored so the form can fail fast. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/

/** Names the platform already owns — a save using one is rejected. */
export const RESERVED_TOOL_NAMES = ['web_search', 'generate_pdf']

export const MIN_DESCRIPTION_LENGTH = 10
export const MAX_DESCRIPTION_LENGTH = 1024
export const MAX_TOOL_ARGUMENTS = 20
export const DEFAULT_MAX_CHARS = 8000
export const MAX_MAX_CHARS = 32000

/** What a credential value is replaced with before it is ever rendered. */
export const MASKED_CREDENTIAL = '••••••••'

const CREDENTIAL_PLACEHOLDER = /\{\{\s*credential\.([a-zA-Z0-9_]+)\s*\}\}/g
const ARGUMENT_PLACEHOLDER = /\{\{\s*args\.([a-zA-Z0-9_]+)\s*\}\}/g

/** Every `{{args.x}}` key referenced anywhere in a call template. */
export function referencedArgumentKeys(template: ToolRequestTemplate): string[] {
    const source = [
        template.url,
        ...Object.values(template.headers),
        ...Object.values(template.query),
        ...Object.values(template.body ?? {}),
    ].join('\n')
    const keys: string[] = []
    let match = ARGUMENT_PLACEHOLDER.exec(source)
    while (match !== null) {
        if (!keys.includes(match[1])) keys.push(match[1])
        match = ARGUMENT_PLACEHOLDER.exec(source)
    }
    ARGUMENT_PLACEHOLDER.lastIndex = 0
    return keys
}

export function referencesCredential(value: string): boolean {
    const found = CREDENTIAL_PLACEHOLDER.test(value)
    CREDENTIAL_PLACEHOLDER.lastIndex = 0
    return found
}

/**
 * The URL's scheme and host are pinned at definition time, so a placeholder is
 * only ever legal from the path onwards.
 */
export function urlOriginIsLiteral(url: string): boolean {
    const afterScheme = url.indexOf('://')
    if (afterScheme < 0) return false
    const pathStart = url.indexOf('/', afterScheme + 3)
    const origin = pathStart < 0 ? url : url.slice(0, pathStart)
    return !origin.includes('{{')
}

/**
 * A credential value must never reach the screen, so any field whose template
 * pulled one in is rendered from the template — with the credential blanked —
 * instead of from what the server resolved. Fields with no credential in them
 * are shown exactly as they went out.
 */
export function maskOutboundRequest(
    outbound: DryRunResolvedRequest,
    template: ToolRequestTemplate
): DryRunResolvedRequest {
    const mask = (templateValue: string | undefined, resolved: string): string => {
        if (!templateValue || !referencesCredential(templateValue)) return resolved
        return templateValue.replace(CREDENTIAL_PLACEHOLDER, MASKED_CREDENTIAL)
    }

    const maskMap = (
        resolved: Record<string, string>,
        templateMap: Record<string, string>
    ): Record<string, string> => (
        Object.fromEntries(
            Object.entries(resolved ?? {}).map(([key, value]) => [key, mask(templateMap?.[key], value)])
        )
    )

    // The body goes out serialized, so a credential anywhere in it masks the
    // whole payload rather than leaking a fragment of the secret.
    const bodyReferencesCredential = Object.values(template.body ?? {}).some(referencesCredential)

    return {
        method: outbound.method,
        url: mask(template.url, outbound.url),
        headers: maskMap(outbound.headers, template.headers),
        query: maskMap(outbound.query, template.query),
        body: bodyReferencesCredential
            ? Object.fromEntries(
                Object.entries(template.body ?? {}).map(([key, value]) => [
                    key,
                    value.replace(CREDENTIAL_PLACEHOLDER, MASKED_CREDENTIAL),
                ])
            )
            : outbound.body ?? null,
    }
}

/** Parse a stored JSON field, falling back when the row predates a field. */
export function parseJsonField<T>(raw: string | undefined | null, fallback: T): T {
    if (!raw) return fallback
    try {
        return JSON.parse(raw) as T
    } catch {
        return fallback
    }
}

/**
 * The user-facing message the server sent — validation failures come back as
 * `ErrorResponse { error }` — else a status-line fallback.
 */
export async function errorFrom(response: Response, fallback: string): Promise<Error> {
    let detail = ''
    try {
        detail = (await response.text()).trim()
        const parsed = JSON.parse(detail)
        if (parsed && typeof parsed.error === 'string') detail = parsed.error
    } catch { /* not JSON, or the body could not be read */ }
    return new Error(detail || `${fallback}: ${response.status} ${response.statusText}`)
}

/** Every tool the customer has defined, draft ones included. */
export async function listCustomerTools(token: string): Promise<ListCustomerToolsResponse> {
    const response = await fetchWithRetry(endpoints.customerTools, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Get tools failed')
    }

    return (await response.json()) as ListCustomerToolsResponse
}

export async function getCustomerTool(token: string, name: string): Promise<CustomerTool> {
    const response = await fetchWithRetry(endpoints.customerTool(name), {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Get tool failed')
    }

    return (await response.json()) as CustomerTool
}

/**
 * Create or replace a tool. The server bumps `version` and refuses
 * `status: active` until a dry run has recorded a `lastDryRunAt`.
 */
export async function saveCustomerTool(
    token: string,
    payload: UpsertCustomerToolRequest
): Promise<CustomerTool> {
    const response = await fetchWithRetry(endpoints.customerTools, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Save tool failed')
    }

    return (await response.json()) as CustomerTool
}

export async function deleteCustomerTool(token: string, name: string): Promise<void> {
    const response = await fetchWithRetry(endpoints.customerTool(name), {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Delete tool failed')
    }
}

/**
 * One real call with sample arguments. The server stamps `lastDryRunAt` on the
 * stored row when the call succeeds, which is what lets the tool leave
 * `draft`. Single point of contact with that endpoint, so the day its shape
 * moves, only this function does.
 */
export async function dryRunCustomerTool(
    token: string,
    name: string,
    payload: DryRunCustomerToolRequest
): Promise<DryRunResult> {
    const response = await fetchWithRetry(endpoints.customerToolDryRun(name), {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        // A dry run is a real outbound call, so a retry would repeat it
        retries: 0,
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Dry run failed')
    }

    return (await response.json()) as DryRunResult
}

/** Which tools have credentials stored. Values are never returned. */
export async function getToolCredentialStatuses(
    token: string
): Promise<GetToolCredentialStatusListResponse> {
    const response = await fetchWithRetry(endpoints.toolCredentials, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Get tool credentials failed')
    }

    return (await response.json()) as GetToolCredentialStatusListResponse
}

/** Store credential values for a tool. They are encrypted before storage. */
export async function storeToolCredentials(
    token: string,
    payload: StoreToolCredentialsRequest
): Promise<StoreToolCredentialsResponse> {
    const response = await fetchWithRetry(endpoints.toolCredentials, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Store tool credentials failed')
    }

    return (await response.json()) as StoreToolCredentialsResponse
}

/** Remove a tool's stored credential values. */
export async function deleteToolCredentials(token: string, toolType: string): Promise<void> {
    const response = await fetchWithRetry(endpoints.toolCredential(toolType), {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Delete tool credentials failed')
    }
}
