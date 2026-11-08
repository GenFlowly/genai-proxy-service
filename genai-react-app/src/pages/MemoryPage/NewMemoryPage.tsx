import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Breadcrumbs, PillButton, ScrollArea, pageHeaderStyles } from '@genflowly/component-library'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import { useAuth } from '../../context/AuthContext'
import { useLayout } from '../../context/LayoutContext'
import { useToast } from '../../context/ToastContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useProjects } from '../../hooks/queries/useMemories'
import { MemoryKind, scopeFromParam, scopeToParam } from '../../models/memory.models'
import { createMemory } from '../../services/memoriesService'
import KindToggle from './components/KindToggle'
import { kindHelp, projectNames, scopeTitle } from './memoryLabels'
import { memoryPath } from './MemoryPage'
import styles from './MemoryPage.module.scss'

const MAX_TEXT_CHARS = 500
const PROFILE = 'profile'

/** A memory the user writes: where it applies, Core or Episodic, and its text. Saved as version 1. */
export default function NewMemoryPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [params] = useSearchParams()
    const start = scopeFromParam(params.get('scope'))
    const { isNarrow } = useResponsiveBreakpoints()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    usePageTitle()

    const projectsQuery = useProjects()
    const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
    const names = useMemo(() => projectNames(projects), [projects])
    const [where, setWhere] = useState(start.type === 'project' ? start.projectId : PROFILE)
    const [kind, setKind] = useState<MemoryKind>(start.type === 'profile' ? start.kind : 'CORE')
    const [text, setText] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    const listPath = `/memory?scope=${encodeURIComponent(scopeToParam(start))}`
    const trimmed = text.trim()
    const canSave = trimmed.length > 0 && trimmed.length <= MAX_TEXT_CHARS

    const save = async () => {
        if (!canSave) return
        setSaving(true)
        try {
            const projectId = where === PROFILE ? null : where
            const memory = await createMemory(await getAccessTokenSilently(), trimmed, kind, projectId)
            navigate(memoryPath(memory.memoryId, projectId ? { type: 'project', projectId } : { type: 'profile', kind }), { replace: true })
        } catch (error) {
            console.error('Failed to add memory:', error)
            showToast(t('memoryPage.newMemory.failed'))
            setSaving(false)
        }
    }

    return (
        <div className={styles.page}>
            {isNarrow ? (
                <MobileHeader title={t('memoryPage.newMemory.title')} swipeBack={{ to: listPath }} />
            ) : (
                <>
                    <Navbar />
                    <div className={pageHeaderStyles.header}>
                        <Breadcrumbs
                            variant="onHeader"
                            items={[
                                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                                { label: scopeTitle(start, names), onClick: () => navigate(listPath) },
                                { label: t('memoryPage.newMemory.title') },
                            ]}
                        />
                    </div>
                </>
            )}

            <div className={styles.layout}>
                <ScrollArea className={styles.main} data-testid="new-memory">
                    <div className={`${styles.detail} ${styles.narrowForm}`}>
                        <div className={styles.fieldRow}>
                            <div className={styles.field}>
                                <label className={styles.fieldLabel} htmlFor="new-memory-where">{t('memoryPage.newMemory.appliesIn')}</label>
                                <select
                                    id="new-memory-where"
                                    className={styles.select}
                                    value={where}
                                    onChange={event => setWhere(event.target.value)}
                                    data-testid="new-memory-where"
                                >
                                    <option value={PROFILE}>{t('memoryPage.newMemory.profileOption')}</option>
                                    {projects.map(project => (
                                        <option key={project.projectId} value={project.projectId}>
                                            {t('memoryPage.newMemory.projectOption', { name: project.name })}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className={styles.field}>
                                <span className={styles.fieldLabel} id="new-memory-kind">{t('memoryPage.newMemory.kind')}</span>
                                <KindToggle value={kind} onChange={setKind} labelledBy="new-memory-kind" />
                            </div>
                        </div>
                        <p className={styles.help}>{kindHelp(kind, where !== PROFILE)}</p>

                        <div className={styles.field}>
                            <label className={styles.fieldLabel} htmlFor="new-memory-text">{t('memoryPage.newMemory.text')}</label>
                            <textarea
                                id="new-memory-text"
                                className={styles.textArea}
                                value={text}
                                maxLength={MAX_TEXT_CHARS}
                                placeholder={t('memoryPage.newMemory.placeholder')}
                                onChange={event => setText(event.target.value)}
                                spellCheck={false}
                                data-testid="new-memory-text"
                            />
                            <p className={styles.help}>{t('memoryPage.newMemory.hint')}</p>
                        </div>

                        <div className={styles.detailActions}>
                            <PillButton variant="secondary" label={t('memoryPage.move.cancel')} onClick={() => navigate(listPath)} disabled={saving} />
                            <PillButton
                                label={saving ? t('memoryPage.newMemory.saving') : t('memoryPage.newMemory.save')}
                                onClick={save}
                                disabled={!canSave || saving}
                                data-testid="new-memory-save"
                            />
                        </div>
                    </div>
                </ScrollArea>
            </div>
        </div>
    )
}
