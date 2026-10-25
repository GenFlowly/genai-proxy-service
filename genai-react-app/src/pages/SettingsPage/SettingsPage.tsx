import React from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { SettingsSidebar } from './components/SettingsSidebar'
import SettingsMenuPage from './SettingsMenuPage'
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
import { useWindowSize } from '../../hooks/useWindowSize'
import { useLayout } from '../../context/LayoutContext'
import { Breadcrumbs, BreadcrumbItem, ResizableSidebar, ScrollArea } from '@genflowly/component-library'

import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
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
    const { width } = useWindowSize()
    const isMobile = width <= 768
    // Matches the SCSS tablet breakpoint (1024px), where the layout stacks
    // into a column and horizontal drag-resizing stops making sense
    const isTablet = width <= 1024
    const navigate = useNavigate()
    const location = useLocation()
    const { setLeftSidebarExpanded } = useLayout()

    // Breadcrumbs (mobile only): Menu > Settings [> Section]
    // Checked as the last-two-segment form first (e.g. 'usage/vector-db')
    // so sub-pages that share a leaf segment name across parent sections
    // (AI's and Usage's 'vector-db') each resolve to their own label.
    const pathSegments = location.pathname.split('/').filter(Boolean)
    const sectionKey =
        SECTION_LABEL_KEYS[pathSegments.slice(-2).join('/')] ??
        SECTION_LABEL_KEYS[pathSegments[pathSegments.length - 1] || '']
    const breadcrumbItems: BreadcrumbItem[] = [
        // "Menu" reopens the mobile menu overlay
        { label: t('settingsPage.settingsPage.breadcrumbMenu'), onClick: () => setLeftSidebarExpanded(true) },
        { label: t('settingsPage.settingsPage.breadcrumbSettings'), onClick: () => navigate('/settings') },
        ...(sectionKey ? [{ label: t(sectionKey), onClick: () => navigate(location.pathname) }] : []),
    ]

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.layout}>
                {/* On mobile the menu is its own page (/settings); the sidebar column is desktop-only.
                    On tablet the layout stacks vertically, so the sidebar renders plain (no resize). */}
                {!isMobile && (
                    isTablet ? (
                        <SettingsSidebar />
                    ) : (
                        <ResizableSidebar
                            storageKey={SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY}
                            defaultWidth={260}
                            minWidth={200}
                            data-testid="settings-sidebar-panel"
                            handleTestId="settings-sidebar-resize-handle"
                        >
                            <SettingsSidebar />
                        </ResizableSidebar>
                    )
                )}
                <ScrollArea className={styles.content}>
                    <div className={styles.contentInner}>
                        {isMobile && <Breadcrumbs items={breadcrumbItems} />}
                        <Routes>
                            {/* Mobile: /settings shows the menu as a full page.
                                Desktop: /settings redirects to the first section. */}
                            <Route path="/" element={isMobile ? <SettingsMenuPage /> : <Navigate to="profile" replace />} />
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