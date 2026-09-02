import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth0 } from '@auth0/auth0-react'
import { DefaultGraphResponse } from '../models/defaultGraph.models'
import { AgentResponse, RequestAgentMapStatus } from '../models/requestAgents.models'
import { getDefaultGraph } from '../services/defaultGraphService'
import { getAgents, getRequestAgentMap } from '../services/requestAgentsService'

function prettyRequestType(requestType: string): string {
    return requestType
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

/**
 * Every system-published agent as a tile: the customer-facing default graph
 * plus each request-type agent. Tiles open the visual editor; request types
 * still running on bundled config defaults link to the mappings page instead
 * (there is no graph to edit yet).
 */
export default function DefaultAgentsPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [defaultGraph, setDefaultGraph] = useState<DefaultGraphResponse | null>(null)
    const [mapStatuses, setMapStatuses] = useState<RequestAgentMapStatus[]>([])
    const [agentsById, setAgentsById] = useState<Map<string, AgentResponse>>(new Map())

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const token = await getAccessTokenSilently()
                const [graph, map, agents] = await Promise.all([
                    getDefaultGraph(token),
                    getRequestAgentMap(token),
                    getAgents(token),
                ])
                if (cancelled) return
                setDefaultGraph(graph)
                setMapStatuses(map.entries)
                setAgentsById(new Map(agents.agents.map((agent) => [agent.graphId, agent])))
            } catch (e) {
                if (!cancelled) {
                    setLoadError(e instanceof Error ? e.message : 'Failed to load agents')
                }
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [getAccessTokenSilently])

    if (loading) return <div className="centered">Loading agents…</div>

    return (
        <section className="page">
            {loadError && <div className="banner error">{loadError}</div>}

            <div className="agent-tiles">
                <Link to="/default-agents/default-graph" className="agent-tile">
                    <div className="agent-tile-header">
                        <h3>{defaultGraph?.name ?? 'Default Graph'}</h3>
                        <span className="status-pill priority">Customer chat</span>
                    </div>
                    <span className="map-details">
                        {defaultGraph
                            ? `${defaultGraph.nodes.length} node(s)`
                            : 'Not published — click to create'}
                    </span>
                </Link>

                {mapStatuses.map((status) => {
                    const entry = status.ddbEntry
                    const agent = entry ? agentsById.get(entry.graphId) : undefined
                    const target = entry
                        ? `/default-agents/agent/${entry.graphId}`
                        : '/default-agents/mappings'
                    return (
                        <Link key={status.requestType} to={target} className="agent-tile">
                            <div className="agent-tile-header">
                                <h3>{prettyRequestType(status.requestType)}</h3>
                                {entry ? (
                                    <span className={`status-pill ${entry.enabled ? 'ok' : ''}`}>
                                        {entry.enabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                ) : (
                                    <span className="status-pill">Built-in</span>
                                )}
                            </div>
                            <span className="map-details">
                                {entry
                                    ? (agent
                                        ? `${agent.name} · ${agent.nodes.length} node(s)`
                                        : entry.graphId)
                                    : 'Bundled default — click to set up'}
                            </span>
                        </Link>
                    )
                })}
            </div>

            <div className="form-actions">
                <Link to="/default-agents/mappings" className="back-link">
                    Manage request-type mappings →
                </Link>
            </div>
        </section>
    )
}
