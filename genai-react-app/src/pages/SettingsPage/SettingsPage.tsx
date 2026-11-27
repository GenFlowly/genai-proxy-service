import React, { useCallback, useMemo, useState } from 'react'
import { Route, Navigate, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ResizableSidebar, ScrollArea } from '@genflowly/component-library'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useLayout } from '../../context/LayoutContext'
import { useRightEdgeSwipe } from '../../context/EdgeSwipeContext'
import { ICONS } from '../../constants/icons'
import { SettingsSidebar } from './components/SettingsSidebar'
import { SettingsFrame } from './components/SettingsFrame'
import { AccountSettings } from './components/profile/AccountSettings'
import { PrivacySettings } from './components/profile/PrivacySettings'
import { BlockedUsersSettings } from './components/profile/BlockedUsersSettings'
import { DeleteDataSettings } from './components/DeleteDataSettings'
import { AISettings } from './components/AISettings'
import { EmbeddingKeysSettings } from './components/EmbeddingKeysSettings'
import { VectorDBSettings } from './components/VectorDBSettings'
import { WebSearchToolSettings } from './components/WebSearchToolSettings'
import { DefaultsSettings } from './components/DefaultsSettings'
import { LearnedFactsSettings } from './components/LearnedFactsSettings'
import { ChatIndexingSettings } from './components/ChatIndexingSettings'
import { EmbeddingModelDefaults } from './components/EmbeddingModelDefaults'
import { LlmUsageSettings } from './components/usage/LlmUsageSettings'
import { EmbeddingUsageSettings } from './components/usage/EmbeddingUsageSettings'
import { VectorDbUsageSettings } from './components/usage/VectorDbUsageSettings'
import { WebSearchUsageSettings } from './components/usage/WebSearchUsageSettings'
import { ToolsSettings } from './components/ToolsSettings'
import { ConnectorsSettings } from './components/ConnectorsSettings'
import { DeveloperSettings } from './components/DeveloperSettings'
import { findSettingsLocation } from './settingsNav'
import { SettingsHeaderInfo, SettingsShellContext } from './SettingsShellContext'
import { SentryRoutes } from '../../observability/SentryRoutes'
import styles from './SettingsPage.module.scss'

const SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY = 'settings_sidebar_width_rem'

/** Old URLs → their pages in the regrouped menu. */
const REDIRECTS: Record<string, string> = {
    '': '/settings/profile/account',
    profile: '/settings/profile/account',
    byok: '/settings/byok/llm-keys',
    ai: '/settings/byok/llm-keys',
    'ai/vendor-keys': '/settings/byok/llm-keys',
    'ai/model-keys': '/settings/byok/llm-keys',
    'ai/llm-keys': '/settings/byok/llm-keys',
    'ai/embedding-keys': '/settings/byok/embedding-keys',
    'ai/vector-db': '/settings/byok/vector-db',
    'ai/defaults': '/settings/defaults/agents',
    actions: '/settings/defaults/agents',
    defaults: '/settings/defaults/agents',
    usage: '/settings/usage/llm-models',
}

export default function SettingsPage(): React.ReactElement {
    const { t } = useTranslation()
    usePageTitle()
    // isNarrow matches the SCSS tablet breakpoint (1024px): below it the menu
    // is the full-page L2 Menu and pages use their phone layout.
    const { isNarrow } = useResponsiveBreakpoints()
    const location = useLocation()
    const { setLeftSidebarExpanded } = useLayout()
    const [infoOpen, setInfoOpen] = useState(false)
    const [header, setHeader] = useState<SettingsHeaderInfo | null>(null)

    const openInfo = useCallback(() => setInfoOpen(true), [])
    const closeInfo = useCallback(() => setInfoOpen(false), [])
    const shell = useMemo(
        () => ({ narrow: isNarrow, infoOpen, openInfo, closeInfo, setHeader }),
        [isNarrow, infoOpen, openInfo, closeInfo]
    )

    const canOpenInfo = isNarrow && !!header?.hasKnowledge
    useRightEdgeSwipe(canOpenInfo ? openInfo : undefined)

    const { section, page } = findSettingsLocation(location.pathname)
    const title = t(page?.labelKey ?? section?.labelKey ?? 'settingsPage.nav.title')
    const subtitle = [page && section ? t(section.labelKey) : t('settingsPage.nav.title'), header?.statusText]
        .filter(Boolean)
        .join(' · ')

    return (
        <SettingsShellContext.Provider value={shell}>
            <div className={styles.page}>
                {!isNarrow && <Navbar />}
                {isNarrow && (
                    <MobileHeader
                        title={title}
                        subtitle={subtitle || undefined}
                        menuTitle={t('settingsPage.nav.title')}
                        menuContent={<SettingsSidebar menu onNavigate={() => setLeftSidebarExpanded(false)} />}
                        trailingAction={canOpenInfo ? {
                            icon: ICONS.INFO,
                            label: t('settingsPage.frame.aboutTitle'),
                            onClick: openInfo,
                            'data-testid': 'settings-info-button',
                        } : undefined}
                    />
                )}
                <div className={styles.layout}>
                    {!isNarrow && (
                        <ResizableSidebar
                            storageKey={SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY}
                            defaultWidth={260}
                            minWidth={200}
                            data-testid="settings-sidebar-panel"
                            handleTestId="settings-sidebar-resize-handle"
                        >
                            <SettingsSidebar />
                        </ResizableSidebar>
                    )}
                    <ScrollArea className={styles.content}>
                        <div className={styles.contentInner}>
                            <SentryRoutes>
                                {Object.entries(REDIRECTS).map(([from, to]) => (
                                    <Route key={from || 'index'} path={from || '/'} element={<Navigate to={to} replace />} />
                                ))}
                                <Route path="profile/account" element={<AccountSettings />} />
                                <Route path="profile/privacy" element={<PrivacySettings />} />
                                <Route path="profile/blocked" element={<BlockedUsersSettings />} />
                                <Route path="profile/delete" element={<DeleteDataSettings />} />
                                <Route path="byok/llm-keys" element={<AISettings />} />
                                <Route path="byok/embedding-keys" element={<EmbeddingKeysSettings />} />
                                <Route path="byok/vector-db" element={<VectorDBSettings />} />
                                <Route path="byok/web-search" element={<WebSearchToolSettings />} />
                                <Route path="defaults/agents" element={<DefaultsSettings />} />
                                <Route path="defaults/memory" element={<LearnedFactsSettings />} />
                                <Route path="defaults/search-index" element={<ChatIndexingSettings />} />
                                <Route path="defaults/embedding-models" element={<EmbeddingModelDefaults />} />
                                <Route path="usage/llm-models" element={<LlmUsageSettings />} />
                                <Route path="usage/embedding-models" element={<EmbeddingUsageSettings />} />
                                <Route path="usage/vector-db" element={<VectorDbUsageSettings />} />
                                <Route path="usage/web-search" element={<WebSearchUsageSettings />} />
                                <Route path="developer" element={<DeveloperSettings />} />
                                <Route path="tools" element={<SettingsFrame page="tools"><ToolsSettings /></SettingsFrame>} />
                                <Route path="connectors" element={<SettingsFrame page="connectors"><ConnectorsSettings /></SettingsFrame>} />
                                <Route path="*" element={<Navigate to="/settings/profile/account" replace />} />
                            </SentryRoutes>
                        </div>
                    </ScrollArea>
                </div>
            </div>
        </SettingsShellContext.Provider>
    )
}
