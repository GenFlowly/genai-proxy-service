import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import {
    CustomerTool,
    CustomerToolMethod,
    ToolParametersSchema,
    ToolRequestTemplate,
    ToolResponseTransform,
    errorFrom,
} from './customerToolsService'

// Mirrors the connectors contract. A connector is not a table: it is a view
// over CustomerTools rows that the server derives by grouping them, so
// everything here reads or writes those same rows.

export type ConnectorKind = 'openapi' | 'mcp'

/** One connected thing, as the server groups the rows it produced. */
export interface Connector {
    /** Stable id: an MCP row's name, or a slug of the spec URL */
    id: string
    kind: ConnectorKind
    label: string
    /** The spec or server URL the tools came from */
    ref: string
    toolCount: number
    /** Key into the customer's stored credentials, or "" */
    credentialRef: string
    connectedAt?: string | null
}

export interface ListConnectorsResponse {
    connectors: Connector[]
}

/**
 * One operation a spec offers, already shaped as a tool record minus
 * `credentialRef` — the caller fills that in.
 */
export interface SpecOperation {
    name: string
    description: string
    method: CustomerToolMethod
    path: string
    parameters: ToolParametersSchema
    request: ToolRequestTemplate
    responseTransform: ToolResponseTransform
    /** Things worth knowing about this one, from the parse */
    warnings?: string[]
}

/** An operation the spec describes that cannot become a tool, and why. */
export interface SkippedOperation {
    operationId: string
    reason: string
}

/**
 * Field names are the retrieval server's, because the proxy forwards its
 * payload untouched — the same arrangement as the dry run result.
 */
export interface SpecPreviewResult {
    ok: boolean
    title: string
    server_url: string
    operations: SpecOperation[]
    skipped: SkippedOperation[]
    error?: string | null
}

/** One tool an MCP server says it offers, exactly as it described it. */
export interface DiscoveredTool {
    name: string
    description: string
    inputSchema?: Record<string, unknown>
}

/** Field names are the retrieval server's, as above. */
export interface McpDiscoveryResult {
    ok: boolean
    server_name: string
    tool_count: number
    tools: DiscoveredTool[]
    error?: string | null
}

export interface PreviewSpecConnectorRequest {
    specUrl: string
    /** Names the credential the drafts will read. Never a value. */
    credentialRef: string
}

export interface ImportSpecConnectorRequest {
    specUrl: string
    credentialRef: string
    /** Exactly the operations the user ticked, at most MAX_IMPORTED_OPERATIONS */
    operations: SpecOperation[]
}

export interface ImportSpecConnectorResponse {
    connector: Connector
    /** The rows that were created, all of them drafts */
    tools: CustomerTool[]
}

export interface DiscoverMcpConnectorRequest {
    serverUrl: string
    credentialRef: string
    /**
     * Sent before any call has arguments, so only credential placeholders
     * belong here. The values are resolved server-side from `credentialRef`.
     */
    headers: Record<string, string>
}

export interface ConnectMcpConnectorRequest {
    serverUrl: string
    credentialRef: string
    /** What the customer calls this connection */
    label: string
    headers: Record<string, string>
    /** The approved list, pinned onto the row exactly as it was approved */
    tools: DiscoveredTool[]
}

export interface ConnectMcpConnectorResponse {
    connector: Connector
    tool: CustomerTool
}

/**
 * How many operations one import may bring in. A long spec is not a tool list;
 * every tool imported is described to the assistant on every request.
 */
export const MAX_IMPORTED_OPERATIONS = 20

/** The credential key the server authorization header reads. */
export const MCP_CREDENTIAL_KEY = 'token'

/** The header an MCP server is asked with. Placeholder only, never a value. */
export const MCP_AUTH_HEADERS: Record<string, string> = {
    Authorization: `Bearer {{credential.${MCP_CREDENTIAL_KEY}}}`,
}

/** Used when a spec's own call templates name no credential key. */
export const DEFAULT_SPEC_CREDENTIAL_KEY = 'api_key'

const CREDENTIAL_PLACEHOLDER = /\{\{\s*credential\.([a-zA-Z0-9_]+)\s*\}\}/g

/**
 * The `{{credential.x}}` keys the chosen operations will read at call time, so
 * the one key the customer pasted is stored under exactly the names the
 * imported drafts look for.
 */
export function credentialKeysForOperations(operations: SpecOperation[]): string[] {
    const source = operations
        .flatMap(operation => [
            operation.request?.url ?? '',
            ...Object.values(operation.request?.headers ?? {}),
            ...Object.values(operation.request?.query ?? {}),
            ...Object.values(operation.request?.body ?? {}),
        ])
        .join('\n')
    const keys: string[] = []
    let match = CREDENTIAL_PLACEHOLDER.exec(source)
    while (match !== null) {
        if (!keys.includes(match[1])) keys.push(match[1])
        match = CREDENTIAL_PLACEHOLDER.exec(source)
    }
    CREDENTIAL_PLACEHOLDER.lastIndex = 0
    return keys
}

/**
 * A credential name suggested from the address the customer pasted, so the
 * usual case needs no thought: api.example.com becomes EXAMPLE.
 */
export function suggestedCredentialRef(url: string): string {
    const afterScheme = url.indexOf('://')
    if (afterScheme < 0) return ''
    const pathStart = url.indexOf('/', afterScheme + 3)
    const host = (pathStart < 0 ? url.slice(afterScheme + 3) : url.slice(afterScheme + 3, pathStart))
        .split(':')[0]
    const labels = host.split('.').filter(Boolean)
    if (labels.length === 0) return ''
    // The registrable name: the label before the top-level one
    const name = labels.length > 1 ? labels[labels.length - 2] : labels[0]
    return name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

/** Every connector the customer has, derived from their tools. */
export async function listConnectors(token: string): Promise<ListConnectorsResponse> {
    const response = await fetchWithRetry(endpoints.connectors, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Get connectors failed')
    }

    return (await response.json()) as ListConnectorsResponse
}

/**
 * Reads the spec and reports what it offers. Nothing is written. The address
 * is the customer's, so it is fetched by the hardened client behind the proxy
 * and never by this browser.
 */
export async function previewSpecConnector(
    token: string,
    payload: PreviewSpecConnectorRequest
): Promise<SpecPreviewResult> {
    const response = await fetchWithRetry(endpoints.connectorOpenApiPreview, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        // A preview fetches someone else's server, so a retry would hit it again
        retries: 0,
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Preview failed')
    }

    return (await response.json()) as SpecPreviewResult
}

/**
 * Saves the chosen operations as draft tools. All or nothing: if one fails
 * validation the server rejects the batch and names it, rather than leaving
 * half a connector behind.
 */
export async function importSpecConnector(
    token: string,
    payload: ImportSpecConnectorRequest
): Promise<ImportSpecConnectorResponse> {
    const response = await fetchWithRetry(endpoints.connectorOpenApiImport, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Import failed')
    }

    return (await response.json()) as ImportSpecConnectorResponse
}

/**
 * Asks the server what it offers and reports the answer. Nothing is written,
 * and the credential is resolved server-side from `credentialRef`.
 */
export async function discoverMcpConnector(
    token: string,
    payload: DiscoverMcpConnectorRequest
): Promise<McpDiscoveryResult> {
    const response = await fetchWithRetry(endpoints.connectorMcpDiscover, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        // Discovery reaches someone else's server, so a retry would hit it again
        retries: 0,
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Discovery failed')
    }

    return (await response.json()) as McpDiscoveryResult
}

/**
 * Saves the connection with the approved list pinned to it. What is sent here
 * is what the assistant is told about, until it is approved again.
 */
export async function connectMcpConnector(
    token: string,
    payload: ConnectMcpConnectorRequest
): Promise<ConnectMcpConnectorResponse> {
    const response = await fetchWithRetry(endpoints.connectorMcpConnect, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Connect failed')
    }

    return (await response.json()) as ConnectMcpConnectorResponse
}

/** Deletes every tool the connector produced. */
export async function disconnectConnector(token: string, id: string): Promise<void> {
    const response = await fetchWithRetry(endpoints.connector(id), {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await errorFrom(response, 'Disconnect failed')
    }
}
