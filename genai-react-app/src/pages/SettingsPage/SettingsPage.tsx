import React from 'react'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import styles from './SettingsPage.module.scss'
import { SettingsSidebar } from './components/SettingsSidebar'
import { ProfileSettings } from './components/ProfileSettings'
import { AISettings } from './components/AISettings'
import { EmbeddingKeysSettings } from './components/EmbeddingKeysSettings'
import { VectorDBSettings } from './components/VectorDBSettings'
import { LlmUsageSettings } from './components/usage/LlmUsageSettings'
import { EmbeddingUsageSettings } from './components/usage/EmbeddingUsageSettings'
import { VectorDbUsageSettings } from './components/usage/VectorDbUsageSettings'
import { WebSearchUsageSettings } from './components/usage/WebSearchUsageSettings'
import { DefaultsSettings } from './components/DefaultsSettings'
import { ToolsSettings } from './components/ToolsSettings'
import { ConnectorsSettings } from './components/ConnectorsSettings'
import { DeveloperSettings } from './components/DeveloperSettings'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useLayout } from '../../context/LayoutContext'
import { ResizableSidebar, ScrollArea } from '@genflowly/component-library'

import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY = 'settings_sidebar_width_rem'

// Translation keys for the section breadcrumb, keyed by the route segment
const SECTION_LABEL_KEYS: Record<string, string> = {
    profile: 'settingsPage.settingsPage.sectionProfile',
    ai: 'settingsPage.settingsPage.sectionAi',
    defaults: 'settingsPage.settingsPage.sectionDefaults',
    tools: 'settingsPage.settingsPage.sectionTools',
    connectors: 'settingsPage.settingsPage.sectionConnectors',
    developer: 'settingsPage.settingsPage.sectionDeveloper',
    // AI sub-sections
    'llm-keys': 'settingsPage.settingsPage.sectionAiModelKeys',
    'embedding-keys': 'settingsPage.settingsPage.sectionAiEmbeddingKeys',
    'vector-db': 'settingsPage.settingsPage.sectionAiVectorDb',
    // Usage sub-sections
    usage: 'settingsPage.settingsPage.sectionUsage',
    'llm-models': 'settingsPage.settingsPage.sectionUsageLlmModels',
    'embedding-models': 'settingsPage.settingsPage.sectionUsageEmbeddingModels',
    'web-search': 'settingsPage.settingsPage.sectionUsageWebSearch',
    // 'usage/vector-db' is deliberately namespaced: the bare 'vector-db' key
    // above already belongs to the AI section, and the lookup below checks
    // the last-two-segment form first so this one wins over that one here.
    'usage/vector-db': 'settingsPage.settingsPage.sectionUsageVectorDb',
}

export default function SettingsPage(): React.ReactElement {
    const { t } = useTranslation()
    usePageTitle()
    // isNarrow matches the SCSS tablet breakpoint (1024px) — below it there's
    // no room for a persistent sidebar, so the whole menu/content split
    // becomes the same full-page takeover true mobile already uses.
    const { isNarrow } = useResponsiveBreakpoints()
    const location = useLocation()
    const { setLeftSidebarExpanded } = useLayout()

    // Below isNarrow, the MobileHeader title is the active section's own
    // label — checked as the last-two-segment form first (e.g.
    // 'usage/vector-db') so sub-pages that share a leaf segment name across
    // parent sections (AI's and Usage's 'vector-db') each resolve correctly.
    const pathSegments = location.pathname.split('/').filter(Boolean)
    const sectionKey =
        SECTION_LABEL_KEYS[pathSegments.slice(-2).join('/')] ??
        SECTION_LABEL_KEYS[pathSegments[pathSegments.length - 1] || '']
    const sectionTitle = sectionKey ? t(sectionKey) : t('settingsPage.settingsSidebar.title')

    return (
        <div className={styles.page}>
            {!isNarrow && <Navbar />}
            {isNarrow && (
                <MobileHeader
                    title={sectionTitle}
                    menuTitle={t('settingsPage.settingsSidebar.title')}
                    menuContent={<SettingsSidebar onNavigate={() => setLeftSidebarExpanded(false)} />}
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
                        <Routes>
                            <Route path="/" element={<Navigate to="profile" replace />} />
                            <Route path="profile" element={<ProfileSettings />} />
                            {/* AI is a parent section: its sub-pages live under /settings/ai/* */}
                            <Route path="ai" element={<Navigate to="/settings/ai/llm-keys" replace />} />
                            {/* Old URLs kept as redirects — the page was renamed Vendor API Keys → Model API Keys → LLM API Keys */}
                            <Route path="ai/vendor-keys" element={<Navigate to="/settings/ai/llm-keys" replace />} />
                            <Route path="ai/model-keys" element={<Navigate to="/settings/ai/llm-keys" replace />} />
                            <Route path="ai/llm-keys" element={<AISettings />} />
                            <Route path="ai/embedding-keys" element={<EmbeddingKeysSettings />} />
                            <Route path="ai/vector-db" element={<VectorDBSettings />} />
                            {/* Usage is a parent section: its sub-pages live under /settings/usage/* */}
                            <Route path="usage" element={<Navigate to="/settings/usage/llm-models" replace />} />
                            <Route path="usage/llm-models" element={<LlmUsageSettings />} />
                            <Route path="usage/embedding-models" element={<EmbeddingUsageSettings />} />
                            <Route path="usage/vector-db" element={<VectorDbUsageSettings />} />
                            <Route path="usage/web-search" element={<WebSearchUsageSettings />} />
                            {/* Old URLs of the Defaults page (formerly Default Preferences, then Default Actions) */}
                            <Route path="ai/defaults" element={<Navigate to="/settings/defaults" replace />} />
                            <Route path="actions" element={<Navigate to="/settings/defaults" replace />} />
                            <Route path="defaults" element={<DefaultsSettings />} />
                            <Route path="tools" element={<ToolsSettings />} />
                            <Route path="connectors" element={<ConnectorsSettings />} />
                            <Route path="developer" element={<DeveloperSettings />} />
                        </Routes>
                    </div>
                </ScrollArea>
            </div>
        </div>
    )
}