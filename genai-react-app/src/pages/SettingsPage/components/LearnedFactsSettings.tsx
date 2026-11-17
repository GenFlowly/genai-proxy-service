import React, { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SettingsCard, SettingsRow, StatusPill, ToggleRow } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import {
    SaveAIConfigPreferencesRequest,
    saveAIConfigPreferences,
} from '../../../services/saveAIConfigService'
import { getAiPreferences, subscribeAiPreferences } from '../../../stores/aiPreferencesStore'
import { ICONS } from '../../../constants/icons'
import { SettingsFrame } from './SettingsFrame'
import styles from './LearnedFactsSettings.module.scss'

type MemorySwitch = 'memoryLearnFromChats' | 'memoryUseInReplies'

const SWITCHES: { key: MemorySwitch; label: string }[] = [
    { key: 'memoryLearnFromChats', label: 'settingsPage.learnedFacts.fromChats' },
    { key: 'memoryUseInReplies', label: 'settingsPage.learnedFacts.useInReplies' },
]

/**
 * Defaults › Memory: whether the assistant learns facts from chats and uses
 * them in replies. A switch is on until the user turns it off (an unset
 * preference means on, matching the backend) and saves as soon as it
 * changes; after a failed save it falls back to the stored value. Deleting
 * learned facts lives on Profile › Delete your data.
 */
export function LearnedFactsSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const preferences = useSyncExternalStore(subscribeAiPreferences, getAiPreferences)
    const [pending, setPending] = useState<Partial<Record<MemorySwitch, boolean>>>({})

    const isOn = (key: MemorySwitch) => pending[key] ?? (preferences?.[key] !== false)

    const handleToggle = async (key: MemorySwitch, checked: boolean) => {
        if (!isAuthenticated) {
            showToast(t('settingsPage.learnedFacts.loginFirstToast'))
            return
        }
        setPending(prev => ({ ...prev, [key]: checked }))
        try {
            const token = await getAccessTokenSilently()
            const update: SaveAIConfigPreferencesRequest['aiConfigPreferences'] = {}
            update[key] = checked
            await saveAIConfigPreferences(token, { aiConfigPreferences: update })
        } catch (error: any) {
            console.error('Failed to save memory setting:', error)
            showToast(error?.message || t('settingsPage.learnedFacts.saveErrorToast'))
        } finally {
            setPending(prev => {
                const next = { ...prev }
                delete next[key]
                return next
            })
        }
    }

    const learning = isOn('memoryLearnFromChats')
    const statusText = learning ? t('settingsPage.memoryDefaults.learningOn') : t('settingsPage.memoryDefaults.learningOff')
    const knowledge = [
        { title: t('settingsPage.memoryDefaults.learnsTitle'), text: t('settingsPage.memoryDefaults.learnsText') },
        { title: t('settingsPage.memoryDefaults.runsTitle'), text: t('settingsPage.memoryDefaults.runsText') },
        { title: t('settingsPage.memoryDefaults.goesTitle'), text: t('settingsPage.memoryDefaults.goesText') },
    ]

    return (
        <SettingsFrame
            page="memory"
            knowledge={knowledge}
            statusText={statusText}
            status={<StatusPill kind={learning ? 'ok' : 'unset'}>{statusText}</StatusPill>}
        >
            <SettingsCard title={t('settingsPage.deleteData.factsCard')} icon={ICONS.BRAIN}>
                {SWITCHES.map(({ key, label }) => (
                    <ToggleRow
                        key={key}
                        label={t(label)}
                        checked={isOn(key)}
                        onChange={checked => void handleToggle(key, checked)}
                        disabled={key in pending}
                        data-testid={`learned-facts-${key}`}
                    />
                ))}
                <SettingsRow
                    label={<span className={styles.muted}>{t('settingsPage.memoryDefaults.listedNote')}</span>}
                    stackOnNarrow={false}
                    action={<Link to="/memory" className={styles.link}>{t('settingsPage.memoryDefaults.openMemory')}</Link>}
                />
            </SettingsCard>
        </SettingsFrame>
    )
}
