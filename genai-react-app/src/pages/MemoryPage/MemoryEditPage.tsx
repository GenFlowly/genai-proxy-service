import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { DetailShell, DiffText, detailStyles as styles, focusAtEnd } from '../../components/DetailPage/DetailParts'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { MemoryApiError, editMemory } from '../../services/memoriesService'
import { scopeTitle } from './memoryLabels'
import { MAX_TEXT_CHARS, memorySubPath, useMemoryPage } from './memoryDetail'

/**
 * A memory's editor on its own page (phones). `?version=N` starts from an
 * older version, so saving restores it. Every save is a new version.
 */
export default function MemoryEditPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const { params, detailQuery, detail, memory, names, scope } = useMemoryPage()
    usePageTitle()

    const latest = memory?.version ?? 1
    const asked = Number(params.get('version'))
    const from = detail?.versions.find(v => v.version === asked && asked !== latest)
    const startText = from?.text ?? memory?.text ?? ''
    const [draft, setDraft] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => setDraft(null), [memory?.memoryId, asked])

    const text = draft ?? startText
    const trimmed = text.trim()
    const canSave = !!memory && trimmed.length > 0 && trimmed.length <= MAX_TEXT_CHARS && trimmed !== memory.text
    const detailPath = memory ? memorySubPath(memory.memoryId, '', scope) : '/memory'

    const save = async () => {
        if (!memory || !canSave) return
        setSaving(true)
        try {
            const updated = await editMemory(await getAccessTokenSilently(), memory.memoryId, trimmed, memory.version)
            showToast(t('memoryPage.detail.saved', { version: updated.version }))
            navigate(detailPath, { replace: true })
        } catch (error) {
            console.error('Failed to save memory:', error)
            const conflict = error instanceof MemoryApiError && error.status === 409
            showToast(t(conflict ? 'memoryPage.detail.conflict' : 'memoryPage.detail.saveFailed'))
            if (conflict) detailQuery.refetch()
        } finally {
            setSaving(false)
        }
    }

    const actions = (
        <>
            <PillButton variant="secondary" label={t('memoryPage.page.cancel')} onClick={() => navigate(detailPath)} disabled={saving} data-testid="memory-edit-cancel" />
            <PillButton
                label={saving ? t('memoryPage.detail.saving') : t('memoryPage.detail.save', { next: latest + 1 })}
                onClick={save}
                disabled={!canSave || saving}
                data-testid="memory-save"
            />
        </>
    )

    return (
        <DetailShell
            narrow={isNarrow}
            title={t('memoryPage.page.editTitle')}
            subtitle={scope ? scopeTitle(scope, names) : undefined}
            breadcrumbs={[
                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                { label: t('memoryPage.page.title'), onClick: () => navigate(detailPath) },
                { label: t('memoryPage.page.editTitle') },
            ]}
            back={{ label: t('memoryPage.page.back'), to: detailPath }}
            data-testid="memory-edit-page"
        >
            {detailQuery.isPending && <div className={styles.state}>{t('memoryPage.list.loading')}</div>}
            {detailQuery.isError && <div className={styles.state}>{t('memoryPage.detail.loadFailed')}</div>}
            {memory && (
                <>
                    {from && (
                        <div className={styles.banner} role="status">
                            {t('memoryPage.page.editingOlder', { version: from.version, next: latest + 1 })}
                        </div>
                    )}
                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="memory-edit-text">{t('memoryPage.detail.textLabel')}</label>
                        <textarea
                            id="memory-edit-text"
                            className={styles.textArea}
                            value={text}
                            maxLength={MAX_TEXT_CHARS}
                            onChange={event => setDraft(event.target.value)}
                            ref={focusAtEnd}
                            data-testid="memory-text"
                        />
                        <div className={styles.fieldFoot}>
                            <span>{t('memoryPage.page.kept')}</span>
                            <span className={styles.count}>{text.length} / {MAX_TEXT_CHARS}</span>
                        </div>
                    </div>
                    {canSave && (
                        <section className={styles.preview} aria-label={t('memoryPage.page.yourChange')} data-testid="memory-change-preview">
                            <span className={styles.fieldLabel}>{t('memoryPage.page.yourChange')}</span>
                            <p className={styles.bigText} style={{ fontSize: '0.95rem' }}>
                                <DiffText before={memory.text} after={trimmed} />
                            </p>
                        </section>
                    )}
                    <div className={isNarrow ? styles.stickyActions : styles.desktopActions}>{actions}</div>
                </>
            )}
        </DetailShell>
    )
}
