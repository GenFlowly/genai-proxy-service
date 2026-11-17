import React, { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCustomerAgents } from '../../../../hooks/queries/useCustomerAgents'
import { saveAIConfigPreferences } from '../../../../services/saveAIConfigService'
import { useToast } from '../../../../context/ToastContext'
import { Agent, agentCategory, effectiveDefaultAgentId } from '../../../../models/agents.models'
import styles from './AgentPickerWidget.module.scss'
import { SidebarWidget } from '@genflowly/component-library'
import { ICONS } from '../../../../constants/icons'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'

/**
 * The Agent card: the agent (graph) a conversation runs through.
 * Lists only CONVERSATION-category agents the customer can access (own +
 * System-published) — memory/title/instruction agents never belong in a
 * conversation, whether mapped (requestType set) or not. No explicit pick
 * (selectedAgentId=null) follows the server-side default: the customer's
 * default agent, else the System one.
 */
export default function AgentPickerWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}): React.ReactElement {
    const { t } = useTranslation()
    const { ai, auth } = useSidebarWidget()
    const { selectedAgentId, setSelectedAgentId } = ai
    const { getAccessTokenSilently, isSignedOut } = auth
    const { showToast } = useToast()

    // Shared query (one /agents request per login at most): the cached copy
    // paints instantly; other consumers reuse the same data.
    const { data: agentsData, isError } = useCustomerAgents()

    // Only conversation agents belong here: the category filter keeps
    // memory/title/instruction agents out, and the requestType filter
    // additionally drops mapped internal agents (belt and braces).
    const agents = useMemo(
        () => (agentsData?.agents || []).filter(a => !a.requestType && agentCategory(a) === 'CONVERSATION'),
        [agentsData]
    )
    const loadFailed = isError && !agentsData

    // The ONE default agent: the user's pick when set, else their own default
    // graph, else the System default (fresh users with no created agents).
    const defaultId = useMemo(
        () => effectiveDefaultAgentId(agents, selectedAgentId),
        [agents, selectedAgentId]
    )

    // A stale pick (agent deleted since last visit) falls back to the graph
    // defaults rather than sending a graphId the server will reject.
    useEffect(() => {
        if (agents.length === 0) return
        if (selectedAgentId && !agents.some(a => a.graphId === selectedAgentId)) {
            setSelectedAgentId(null)
        }
    }, [agents, selectedAgentId, setSelectedAgentId])

    // Picking an agent MAKES it the default — stored locally and pushed to the
    // account preferences so it follows the user across devices; localStorage
    // keeps it working when the save fails.
    const handlePickId = (graphId: string) => {
        setSelectedAgentId(graphId)
        ;(async () => {
            try {
                const token = await getAccessTokenSilently()
                await saveAIConfigPreferences(token, {
                    aiConfigPreferences: { preferredAgentId: graphId },
                })
            } catch (err) {
                console.error('Failed to save agent preference:', err)
                showToast(t('sidebar.agentPickerWidget.failedToSave'))
            }
        })()
    }

    const optionLabel = (agent: Agent) => {
        const badges = [
            agent.isSystem ? t('sidebar.agentPickerWidget.systemBadge') : null,
            agent.graphId === defaultId ? t('sidebar.agentPickerWidget.defaultBadge') : null,
        ].filter(Boolean)
        return badges.length ? `${agent.name} (${badges.join(', ')})` : agent.name
    }

    return (
        <SidebarWidget
            title={t('sidebar.agentPickerWidget.title')}
            icon={ICONS.USER_ROLE}
            bodyClassName={styles.body}
            data-testid={testId || 'agent-picker-widget'}
        >
            {isSignedOut && (
                <span className={styles.emptyText}>{t('sidebar.agentPickerWidget.pleaseLogInFirst')}</span>
            )}
            {loadFailed && (
                <span className={styles.errorText}>{t('sidebar.agentPickerWidget.failedToLoad')}</span>
            )}
            {!isSignedOut && !loadFailed && agents.length === 0 && (
                <span className={styles.emptyText}>{t('sidebar.agentPickerWidget.noAgents')}</span>
            )}
            {agents.length > 0 && (
                <select
                    className={styles.agentSelect}
                    value={defaultId ?? ''}
                    onChange={e => handlePickId(e.target.value)}
                    data-testid="agent-picker-select"
                    aria-label={t('sidebar.agentPickerWidget.title')}
                >
                    {agents.map(agent => (
                        <option key={agent.graphId} value={agent.graphId} data-testid={`agent-option-${agent.graphId}`}>
                            {optionLabel(agent)}
                        </option>
                    ))}
                </select>
            )}
        </SidebarWidget>
    )
}
