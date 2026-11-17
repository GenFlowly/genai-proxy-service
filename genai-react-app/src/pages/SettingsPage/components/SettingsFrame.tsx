import React, { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsPageLayout } from '@genflowly/component-library'
import type { KnowledgeItem } from '@genflowly/component-library'
import { findSettingsPage } from '../settingsNav'
import { useSettingsShell } from '../SettingsShellContext'

interface SettingsFrameProps {
    /** The page's id in settingsNav, e.g. 'llm-keys' or 'usage-vector-db'. */
    page: string
    /** Pill(s) next to the desktop title. */
    status?: React.ReactNode
    /** The same status as plain text, for the phone header's subtitle. */
    statusText?: string
    knowledge?: KnowledgeItem[]
    children: React.ReactNode
}

/**
 * Every settings page sits in this frame: breadcrumb, title and status, the
 * knowledge strip, then its cards. On phones the knowledge moves into the
 * info drawer, and the page hands its status to the mobile header.
 */
export function SettingsFrame({ page, status, statusText, knowledge = [], children }: SettingsFrameProps): React.ReactElement {
    const { t } = useTranslation()
    const { narrow, infoOpen, closeInfo, setHeader } = useSettingsShell()
    const location = findSettingsPage(page)
    const title = t(location?.page?.labelKey ?? location?.section.labelKey ?? 'settingsPage.nav.title')
    const section = location?.page ? t(location.section.labelKey) : undefined
    const hasKnowledge = knowledge.length > 0

    useEffect(() => {
        setHeader({ statusText, hasKnowledge })
        return () => setHeader(null)
    }, [setHeader, statusText, hasKnowledge])

    const strings = useMemo(() => ({
        aboutTitle: t('settingsPage.frame.aboutTitle'),
        breadcrumbLabel: t('settingsPage.frame.breadcrumb'),
        closeLabel: t('settingsPage.frame.close'),
        drawerHint: t('settingsPage.frame.drawerHint'),
    }), [t])

    return (
        <SettingsPageLayout
            title={title}
            section={section}
            status={status}
            knowledge={knowledge}
            narrow={narrow}
            infoOpen={infoOpen}
            onInfoClose={closeInfo}
            strings={strings}
            data-testid={`settings-page-${page}`}
        >
            {children}
        </SettingsPageLayout>
    )
}
