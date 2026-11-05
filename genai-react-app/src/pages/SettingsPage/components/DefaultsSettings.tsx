import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputSelectWithHint, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useAI } from '../../../context/AIContext'
import { useToast } from '../../../context/ToastContext'
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import {
    CustomerRequestAgentStatus,
    GetCustomerRequestAgentsResponse,
    deleteRequestAgentMapping,
    putRequestAgentMapping,
} from '../../../services/requestAgentsService'
import { useCustomerAgents } from '../../../hooks/queries/useCustomerAgents'
import { useRequestAgents } from '../../../hooks/queries/useRequestAgents'
import {
    Agent,
    GetCustomerAgentsResponse,
    agentCategory,
    effectiveDefaultAgentId,
} from '../../../models/agents.models'
import { ICONS } from '../../../constants/icons'
import { EmbeddingModelDefaults } from './EmbeddingModelDefaults'
import { LearnedFactsSettings } from './LearnedFactsSettings'
import styles from './DefaultsSettings.module.scss'

/**
 * Sentinel select value for "no override — use the platform default".
 * Must be non-empty: InputSelectWithHint reserves the empty value for its
 * hidden placeholder option, so an '' option can never show as selected.
 */
const PLATFORM_DEFAULT = '__platform_default__'

/** The two title flows are served by one agent, so they share one row. */
const TITLE_REQUEST_TYPES = ['CONVERSATION_TITLE', 'NOTE_TITLE']
const TITLE_ROW = 'TITLE'

/** Labels for the known rows; unknown (future) actions fall back to the server's displayName. */
const ROW_LABEL_KEYS: Record<string, string> = {
    [TITLE_ROW]: 'settingsPage.defaultAgents.titleAgent',
    MEMORY_EXTRACTION: 'settingsPage.defaultAgents.learnAboutMeAgent',
    INSTRUCTION_PERSONA: 'settingsPage.defaultAgents.instructionPersonaAgent',
}

interface MappingRow {
    key: string
    /** The backend actions this row's selection applies to (two for the title row). */
    entries: CustomerRequestAgentStatus[]
}

/**
 * One row per backend action, except the two title flows which merge into a
 * single "Title Agent" row whose selection writes both mappings. Known rows
 * keep a fixed order (title, memory, persona); anything the registry adds
 * later renders after them in server order.
 */
function buildRows(entries: CustomerRequestAgentStatus[]): MappingRow[] {
    const titleEntries = entries.filter(e => TITLE_REQUEST_TYPES.includes(e.requestType))
    const rest = entries.filter(e => !TITLE_REQUEST_TYPES.includes(e.requestType))
    const rank = (type: string) => {
        const index = ['MEMORY_EXTRACTION', 'INSTRUCTION_PERSONA'].indexOf(type)
        return index === -1 ? 2 : index
    }
    return [
        ...(titleEntries.length ? [{ key: TITLE_ROW, entries: titleEntries }] : []),
        ...rest
            .slice()
            .sort((a, b) => rank(a.requestType) - rank(b.requestType))
            .map(entry => ({ key: entry.requestType, entries: [entry] })),
    ]
}

/** The override a row currently holds: its first request type with a mapping. */
function rowMappedGraphId(row: MappingRow): string {
    return row.entries.find(e => e.entry?.enabled)?.entry?.graphId ?? PLATFORM_DEFAULT
}

/**
 * The Defaults settings page, in three sections:
 * 1. Default Agents — which agent powers each built-in action (titles,
 *    memory extraction, instruction personas; the action list comes from the
 *    backend RequestType registry, so new actions appear automatically) plus
 *    the Conversation Agent handling new chats (AIConfigPreferences.preferredAgentId).
 * 2. Learned facts — the memory switches and "Delete all learned facts".
 * 3. Default embedding models per data category.
 */
export function DefaultsSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, isAuthenticated, getAccessTokenSilently } = useAuth()
    const { selectedAgentId, setSelectedAgentId } = useAI()
    const { showToast } = useToast()

    const [actions, setActions] = useState<CustomerRequestAgentStatus[]>([])
    const [agents, setAgents] = useState<Agent[]>([])
    const [conversationAgents, setConversationAgents] = useState<Agent[]>([])
    const [selected, setSelected] = useState<Record<string, string>>({})
    const [conversationAgentId, setConversationAgentId] = useState('')
    const [savedConversationAgentId, setSavedConversationAgentId] = useState('')
    const [saving, setSaving] = useState(false)

    // Shared queries: cached copies render immediately (placeholder data) and
    // version gating skips the refetch when nothing changed server-side.
    const { data: actionsData, isError: actionsError, error: actionsErrorObj } = useRequestAgents()
    const { data: agentsData, isError: agentsError, error: agentsErrorObj } = useCustomerAgents()
    const loading = !actionsData || !agentsData

    const applyData = useCallback(
        (actionsResponse: GetCustomerRequestAgentsResponse, agentsResponse: GetCustomerAgentsResponse) => {
            const allAgents = agentsResponse.agents ?? []
            setActions(actionsResponse.entries)
            // Only the user's own agents are candidates for action rows
            // (System agents are the platform defaults). Request-type
            // filtering happens per row — an agent already mapped to an
            // action must stay visible there.
            setAgents(allAgents.filter(a => !a.isSystem))
            // The Conversation Agent row mirrors the chat sidebar picker:
            // CONVERSATION-category agents only, own + System-published.
            setConversationAgents(
                allAgents.filter(a => !a.requestType && agentCategory(a) === 'CONVERSATION')
            )
            setSelected(
                Object.fromEntries(
                    buildRows(actionsResponse.entries).map(row => [row.key, rowMappedGraphId(row)])
                )
            )
        },
        []
    )

    // An unchanged refresh is not re-applied: applying rebuilds the dropdown
    // selections and would discard an in-progress edit. Identity is not enough
    // (a refetch landing over placeholder data is a new object even when its
    // content is identical), so compare content.
    const lastAppliedRef = useRef('')
    useEffect(() => {
        if (!actionsData || !agentsData) return
        const signature = JSON.stringify([actionsData, agentsData])
        if (signature === lastAppliedRef.current) return
        lastAppliedRef.current = signature
        applyData(actionsData, agentsData)
    }, [actionsData, agentsData, applyData])

    // With cached data already on screen a failed refresh is non-fatal
    useEffect(() => {
        if ((actionsError || agentsError) && loading) {
            const message = (actionsErrorObj as Error | null)?.message
                || (agentsErrorObj as Error | null)?.message
            showToast(message || t('settingsPage.defaultAgents.loadErrorToast'))
        }
    }, [actionsError, agentsError, actionsErrorObj, agentsErrorObj, loading, showToast, t])

    // Prefill the Conversation Agent row once agents are in: the user's pick
    // when set, else their own default graph, else the System default.
    useEffect(() => {
        if (savedConversationAgentId || conversationAgents.length === 0) return
        const effective = effectiveDefaultAgentId(conversationAgents, selectedAgentId) ?? ''
        if (!effective) return
        setConversationAgentId(effective)
        setSavedConversationAgentId(effective)
    }, [conversationAgents, selectedAgentId, savedConversationAgentId])

    const rows = useMemo(() => buildRows(actions), [actions])

    const rowLabel = (row: MappingRow) =>
        ROW_LABEL_KEYS[row.key]
            ? t(ROW_LABEL_KEYS[row.key])
            : row.entries[0].displayName || row.key

    /**
     * Options for one row's dropdown: the platform default plus the user's
     * agents. Agents already serving a request type (agent.requestType is set
     * by the backend for mapped graphs) are hidden EXCEPT those currently
     * mapped or selected for this row — otherwise the dropdown couldn't
     * display the existing mapping.
     */
    const optionsFor = useCallback(
        (row: MappingRow) => {
            const mappedGraphIds = row.entries
                .map(e => e.entry?.graphId)
                .filter((id): id is string => !!id)
            const selectedGraphId = selected[row.key]
            const platformAgentName = row.entries[0].platformAgentName
            const platformLabel = platformAgentName
                ? t('settingsPage.defaultAgents.platformDefaultNamed', { agent: platformAgentName })
                : t('settingsPage.defaultAgents.platformDefault')
            return [
                { label: platformLabel, value: PLATFORM_DEFAULT },
                ...agents
                    .filter(
                        agent =>
                            !agent.requestType ||
                            mappedGraphIds.includes(agent.graphId) ||
                            agent.graphId === selectedGraphId
                    )
                    .map(agent => ({ label: agent.name, value: agent.graphId })),
            ]
        },
        [agents, selected, t]
    )

    const conversationOptions = useMemo(
        () =>
            conversationAgents.map(agent => ({
                label: agent.isSystem
                    ? `${agent.name} (${t('settingsPage.defaultAgents.systemBadge')})`
                    : agent.name,
                value: agent.graphId,
            })),
        [conversationAgents, t]
    )

    const handleSave = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.defaultAgents.loginFirstToast'))
            return
        }
        setSaving(true)
        try {
            const token = await getAccessTokenSilently()
            for (const row of rows) {
                const after = selected[row.key] ?? PLATFORM_DEFAULT
                for (const entry of row.entries) {
                    const before = entry.entry?.enabled ? entry.entry.graphId : PLATFORM_DEFAULT
                    if (after === before) continue
                    if (after === PLATFORM_DEFAULT) {
                        await deleteRequestAgentMapping(token, entry.requestType)
                    } else {
                        await putRequestAgentMapping(token, entry.requestType, after)
                    }
                }
            }
            if (conversationAgentId && conversationAgentId !== savedConversationAgentId) {
                await saveAIConfigPreferences(token, {
                    aiConfigPreferences: { preferredAgentId: conversationAgentId },
                })
                setSelectedAgentId(conversationAgentId)
                setSavedConversationAgentId(conversationAgentId)
            }
            showToast(t('settingsPage.defaultAgents.savedToast'))
        } catch (error: any) {
            console.error('Failed to save defaults:', error)
            showToast(error?.message || t('settingsPage.defaultAgents.saveErrorToast'))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className={styles.container}>
            {loading ? (
                <p className={styles.emptyHint}>{t('settingsPage.defaultAgents.loading')}</p>
            ) : (
                <div className={styles.form}>
                    {rows.map(row => (
                        <div className={styles.field} key={row.key}>
                            <label className={styles.fieldLabel}>{rowLabel(row)}</label>
                            <InputSelectWithHint
                                hint={t('settingsPage.defaultAgents.agentHint')}
                                value={selected[row.key] ?? PLATFORM_DEFAULT}
                                onChange={(val: string) =>
                                    setSelected(prev => ({ ...prev, [row.key]: val }))
                                }
                                options={optionsFor(row)}
                                data-testid={`default-agent-${row.key}`}
                            />
                        </div>
                    ))}
                    <div className={styles.field}>
                        <label className={styles.fieldLabel}>
                            {t('settingsPage.defaultAgents.conversationAgent')}
                        </label>
                        <InputSelectWithHint
                            hint={t('settingsPage.defaultAgents.agentHint')}
                            placeholder={t('settingsPage.defaultAgents.conversationPlaceholder')}
                            value={conversationAgentId}
                            onChange={(val: string) => setConversationAgentId(val)}
                            options={conversationOptions}
                            data-testid="default-agent-CONVERSATION"
                        />
                    </div>
                    {agents.length === 0 && (
                        <p className={styles.emptyHint}>{t('settingsPage.defaultAgents.noAgents')}</p>
                    )}
                    <div className={styles.footer}>
                        <PillButton
                            onClick={handleSave}
                            label={
                                saving
                                    ? t('settingsPage.defaultAgents.saving')
                                    : t('settingsPage.defaultAgents.save')
                            }
                            icon={ICONS.SAVE_ICON}
                            disabled={saving}
                        />
                    </div>
                </div>
            )}

            <LearnedFactsSettings />
            <EmbeddingModelDefaults />
        </div>
    )
}
