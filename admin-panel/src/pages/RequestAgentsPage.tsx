import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth0 } from '@auth0/auth0-react'
import { REQUEST_TYPE_LABELS, RequestType } from '../constants/requestTypes'
import { AgentResponse, RequestAgentMapStatus } from '../models/requestAgents.models'
import { DefaultGraphResponse } from '../models/defaultGraph.models'
import { getDefaultGraph } from '../services/defaultGraphService'
import {
    deleteRequestAgentMapEntry,
    getAgents,
    getRequestAgentMap,
    putRequestAgentMapEntry,
} from '../services/requestAgentsService'
import { generationNode } from '../components/AgentManager'

type MapRowState = {
    expanded: boolean
    mapKey: string
    graphId: string
    enabled: boolean
    busy: boolean
    message: string | null
    messageKind: 'success' | 'error' | null
}

const emptyMapRow = (): MapRowState => ({
    expanded: false,
    mapKey: '',
    graphId: '',
    enabled: true,
    busy: false,
    message: null,
    messageKind: null,
})

/**
 * Every default action the app performs, and which agent serves it: the four
 * internal request types plus the customer-chat default agent. Agents are
 * created on the Default Agents page; this page only assigns them.
 */
export default function RequestAgentsPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [mapEntries, setMapEntries] = useState<RequestAgentMapStatus[]>([])
    const [agents, setAgents] = useState<AgentResponse[]>([])
    const [defaultGraph, setDefaultGraph] = useState<DefaultGraphResponse | null>(null)

    const [mapRows, setMapRows] = useState<Record<string, MapRowState>>(() =>
        Object.fromEntries(Object.values(RequestType).map((rt) => [rt, emptyMapRow()]))
    )
    // Base on emptyMapRow so request types the server added after this build
    // (not in the local RequestType enum) still get full row state.
    const updateMapRow = (rt: string, patch: Partial<MapRowState>) =>
        setMapRows((prev) => ({ ...prev, [rt]: { ...emptyMapRow(), ...prev[rt], ...patch } }))

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const [map, agentsResponse, graph] = await Promise.all([
                getRequestAgentMap(token),
                getAgents(token),
                getDefaultGraph(token),
            ])
            setMapEntries(map.entries)
            setAgents(agentsResponse.agents.filter((a) => generationNode(a) !== null))
            setDefaultGraph(graph)
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load request-agent data')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const handleSaveMapping = async (rt: string) => {
        const row = mapRows[rt]
        if (!row.mapKey.trim() || !row.graphId) {
            updateMapRow(rt, { message: 'Pick an agent and a map key first', messageKind: 'error' })
            return
        }
        updateMapRow(rt, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await putRequestAgentMapEntry(token, rt, {
                mapKey: row.mapKey.trim(),
                graphId: row.graphId,
                enabled: row.enabled,
            })
            updateMapRow(rt, {
                busy: false,
                expanded: false,
                message: 'Mapping saved — takes effect within ~1 minute on all instances',
                messageKind: 'success',
            })
            await refresh()
        } catch (e) {
            updateMapRow(rt, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to save mapping',
                messageKind: 'error',
            })
        }
    }

    const handleDisableMapping = async (rt: string) => {
        if (!window.confirm(
            `Disable the ${rt} mapping? The action stops running entirely until it is re-enabled or remapped — there is no fallback.`
        )) return
        updateMapRow(rt, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await deleteRequestAgentMapEntry(token, rt)
            updateMapRow(rt, {
                busy: false,
                message: 'Mapping disabled — the action is off until re-enabled',
                messageKind: 'success',
            })
            await refresh()
        } catch (e) {
            updateMapRow(rt, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to disable mapping',
                messageKind: 'error',
            })
        }
    }

    if (loading) return <div className="centered">Loading request-agent map…</div>

    return (
        <section className="page mappings-page">
            <h2>Default Actions Mapping</h2>

            {loadError && <div className="banner error">{loadError}</div>}

            <div className="vendor-list">
                {mapEntries.map((entry) => {
                    const rt = entry.requestType
                    const row = mapRows[rt] ?? emptyMapRow()
                    const mapped = entry.effectiveSource === 'DDB'
                    const disabled = !mapped && entry.ddbEntry?.enabled === false
                    return (
                        <div className="vendor-card" key={rt}>
                            <div className="vendor-card-header">
                                <h3>{entry.displayName ?? REQUEST_TYPE_LABELS[rt as RequestType] ?? rt}</h3>
                                <div className="header-pills">
                                    <span className={`status-pill ${mapped ? 'ok' : 'unset'}`}>
                                        {mapped ? 'Mapped (DDB)' : disabled ? 'Disabled — action off' : 'Unresolved — action off'}
                                    </span>
                                </div>
                            </div>

                            <div className="map-summary">
                                <span className="map-key">{entry.effectiveMapKey ?? '—'}</span>
                                {entry.ddbEntry && (
                                    <span className="map-details">
                                        → {entry.ddbEntry.graphId}
                                        {!entry.ddbEntry.enabled && ' (disabled)'}
                                        {entry.ddbEntry.updatedBy &&
                                            ` · by ${entry.ddbEntry.updatedBy}`}
                                    </span>
                                )}
                            </div>

                            <div className="vendor-card-body">
                                <button
                                    disabled={row.busy}
                                    onClick={() =>
                                        updateMapRow(rt, {
                                            expanded: !row.expanded,
                                            mapKey: row.mapKey || entry.ddbEntry?.mapKey || '',
                                            graphId: row.graphId || entry.ddbEntry?.graphId || '',
                                            enabled: entry.ddbEntry?.enabled ?? true,
                                        })
                                    }
                                >
                                    {row.expanded ? 'Cancel' : mapped ? 'Remap…' : 'Map agent…'}
                                </button>
                                {entry.ddbEntry?.enabled && (
                                    <button
                                        className="danger"
                                        disabled={row.busy}
                                        onClick={() => void handleDisableMapping(rt)}
                                    >
                                        Disable mapping
                                    </button>
                                )}
                            </div>

                            {row.expanded && (
                                <div className="config-row">
                                    <label className="config-field grow">
                                        Agent
                                        <select
                                            value={row.graphId}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateMapRow(rt, { graphId: e.target.value })
                                            }
                                        >
                                            <option value="">Select an agent…</option>
                                            {agents.map((agent) => (
                                                <option key={agent.graphId} value={agent.graphId}>
                                                    {agent.name} ({agent.graphId})
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="config-field grow">
                                        Map key
                                        <input
                                            type="text"
                                            placeholder="e.g. InstructionRequestCustom"
                                            value={row.mapKey}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateMapRow(rt, { mapKey: e.target.value })
                                            }
                                        />
                                    </label>
                                    <label className="config-field checkbox">
                                        <input
                                            type="checkbox"
                                            checked={row.enabled}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateMapRow(rt, { enabled: e.target.checked })
                                            }
                                        />
                                        Enabled
                                    </label>
                                    <button
                                        className="primary"
                                        disabled={row.busy || !row.graphId || !row.mapKey.trim()}
                                        onClick={() => void handleSaveMapping(rt)}
                                    >
                                        {row.busy ? 'Saving…' : 'Save mapping'}
                                    </button>
                                </div>
                            )}

                            {row.message && (
                                <div className={`row-message ${row.messageKind ?? ''}`}>
                                    {row.message}
                                </div>
                            )}
                        </div>
                    )
                })}

                <div className="vendor-card">
                    <div className="vendor-card-header">
                        <h3>Conversation Default Agent</h3>
                        <div className="header-pills">
                            <span className={`status-pill ${defaultGraph ? 'ok' : 'unset'}`}>
                                {defaultGraph ? 'Published' : 'Not published'}
                            </span>
                        </div>
                    </div>
                    <div className="map-summary">
                        <span className="map-key">
                            {defaultGraph?.name ?? 'No default graph published yet'}
                        </span>
                        {defaultGraph && (
                            <span className="map-details">
                                {defaultGraph.nodes.length} node(s) · serves every customer chat
                                without an own default agent
                            </span>
                        )}
                    </div>
                    <div className="vendor-card-body">
                        <Link to="/default-agents/default-graph" className="back-link">
                            {defaultGraph ? 'Open in graph editor →' : 'Create in graph editor →'}
                        </Link>
                    </div>
                </div>
            </div>

        </section>
    )
}
