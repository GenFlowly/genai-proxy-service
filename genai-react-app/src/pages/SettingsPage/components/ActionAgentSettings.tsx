import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputSelectWithHint, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { getCustomerAgents } from '../../../services/agentsService'
import {
    CustomerRequestAgentStatus,
    deleteRequestAgentMapping,
    getRequestAgents,
    putRequestAgentMapping,
} from '../../../services/requestAgentsService'
import { Agent } from '../../../models/agents.models'
import { ICONS } from '../../../constants/icons'
import styles from './ActionAgentSettings.module.scss'

/**
 * Sentinel select value for "no override — use the platform default".
 * Must be non-empty: InputSelectWithHint reserves the empty value for its
 * hidden placeholder option, so an '' option can never show as selected.
 */
const PLATFORM_DEFAULT = '__platform_default__'

/**
 * Lets a user point the app's default actions (conversation titles, note
 * titles, instruction personas, memory extraction) at one of their own
 * agents instead of the platform defaults. The action list comes from the
 * backend RequestType registry, so new actions appear here automatically.
 */
export function ActionAgentSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, isAuthenticated, getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()

    const [actions, setActions] = useState<CustomerRequestAgentStatus[]>([])
    const [agents, setAgents] = useState<Agent[]>([])
    const [selected, setSelected] = useState<Record<string, string>>({})
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        if (!isAuthenticated) return
        setLoading(true)
        try {
            const token = await getAccessTokenSilently()
            const [actionsResponse, agentsResponse] = await Promise.all([
                getRequestAgents(token),
                getCustomerAgents(token),
            ])
            setActions(actionsResponse.entries)
            // Only the user's own agents are candidates (System agents are
            // the platform defaults). Request-type filtering happens per row —
            // an agent already mapped to an action must stay visible there.
            setAgents((agentsResponse.agents ?? []).filter(a => !a.isSystem))
            setSelected(
                Object.fromEntries(
                    actionsResponse.entries.map(entry => [
                        entry.requestType,
                        entry.entry?.enabled ? entry.entry.graphId : PLATFORM_DEFAULT,
                    ])
                )
            )
        } catch (error: any) {
            console.error('Failed to load default-action mappings:', error)
            showToast(error?.message || t('settingsPage.actionAgents.loadErrorToast'))
        } finally {
            setLoading(false)
        }
    }, [isAuthenticated, getAccessTokenSilently, showToast, t])

    useEffect(() => {
        void load()
    }, [load])

    /**
     * Options for one action's dropdown: the platform default plus the user's
     * agents. Agents already serving a request type (agent.requestType is set
     * by the backend for mapped graphs) are hidden EXCEPT the one currently
     * set or selected for this row — otherwise the dropdown couldn't display
     * the existing mapping.
     */
    const optionsFor = useCallback(
        (action: CustomerRequestAgentStatus) => {
            const currentGraphId = action.entry?.graphId
            const selectedGraphId = selected[action.requestType]
            const platformLabel = action.platformAgentName
                ? t('settingsPage.actionAgents.platformDefaultNamed', { agent: action.platformAgentName })
                : t('settingsPage.actionAgents.platformDefault')
            return [
                { label: platformLabel, value: PLATFORM_DEFAULT },
                ...agents
                    .filter(
                        agent =>
                            !agent.requestType ||
                            agent.graphId === currentGraphId ||
                            agent.graphId === selectedGraphId
                    )
                    .map(agent => ({ label: agent.name, value: agent.graphId })),
            ]
        },
        [agents, selected, t]
    )

    const handleSave = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.actionAgents.loginFirstToast'))
            return
        }
        setSaving(true)
        try {
            const token = await getAccessTokenSilently()
            for (const action of actions) {
                const before = action.entry?.enabled ? action.entry.graphId : PLATFORM_DEFAULT
                const after = selected[action.requestType] ?? PLATFORM_DEFAULT
                if (after === before) continue
                if (after === PLATFORM_DEFAULT) {
                    await deleteRequestAgentMapping(token, action.requestType)
                } else {
                    await putRequestAgentMapping(token, action.requestType, after)
                }
            }
            showToast(t('settingsPage.actionAgents.savedToast'))
            await load()
        } catch (error: any) {
            console.error('Failed to save default-action mappings:', error)
            showToast(error?.message || t('settingsPage.actionAgents.saveErrorToast'))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.actionAgents.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.actionAgents.subtitle')}</p>
            </div>

            {loading ? (
                <p className={styles.emptyHint}>{t('settingsPage.actionAgents.loading')}</p>
            ) : (
                <div className={styles.form}>
                    {actions.map(action => (
                        <div className={styles.field} key={action.requestType}>
                            <label className={styles.fieldLabel}>
                                {action.displayName || action.requestType}
                            </label>
                            <InputSelectWithHint
                                hint={t('settingsPage.actionAgents.agentHint')}
                                value={selected[action.requestType] ?? PLATFORM_DEFAULT}
                                onChange={(val: string) =>
                                    setSelected(prev => ({ ...prev, [action.requestType]: val }))
                                }
                                options={optionsFor(action)}
                                data-testid={`action-agent-${action.requestType}`}
                            />
                        </div>
                    ))}
                    {agents.length === 0 && (
                        <p className={styles.emptyHint}>{t('settingsPage.actionAgents.noAgents')}</p>
                    )}
                    <div className={styles.footer}>
                        <PillButton
                            onClick={handleSave}
                            label={
                                saving
                                    ? t('settingsPage.actionAgents.saving')
                                    : t('settingsPage.actionAgents.save')
                            }
                            icon={ICONS.SAVE_ICON}
                            disabled={saving}
                        />
                    </div>
                </div>
            )}
        </div>
    )
}
