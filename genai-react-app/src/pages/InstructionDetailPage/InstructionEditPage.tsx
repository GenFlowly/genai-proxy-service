import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { InputTextWithHint, PillButton, TextEditor } from '@genflowly/component-library'
import { DetailShell, detailStyles as styles } from '../../components/DetailPage/DetailParts'
import { useAuth } from '../../context/AuthContext'
import { ModerationError } from '../../services/moderationService'
import { useToast } from '../../context/ToastContext'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { createInstruction } from '../../services/instructionService'
import { instructionPath, useInstructionPage } from './instructionDetail'

/**
 * Writing an instruction: a new one (`/instructions/new`) or the next version
 * of one (`/instructions/:id/edit`, `?version=N` to start from an older one).
 */
export default function InstructionEditPage({ isNew = false }: { isNew?: boolean }): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { getAccessTokenSilently, isAuthenticated, isInstructionsLoaded, loginWithRedirect } = useAuth()
    const { showToast } = useToast()
    const { instructionId, latest, shown, older, role, loading } = useInstructionPage()

    const [name, setName] = useState<string | null>(null)
    const [text, setText] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (isNew && isInstructionsLoaded && !isAuthenticated) loginWithRedirect({ appState: { returnTo: window.location.pathname } })
    }, [isNew, isInstructionsLoaded, isAuthenticated, loginWithRedirect])

    useEffect(() => {
        if (!isNew && latest && role === 'VIEW') navigate(instructionPath(instructionId), { replace: true })
    }, [isNew, latest, role, instructionId, navigate])

    const currentName = name ?? (isNew ? '' : shown?.name ?? '')
    const currentText = text ?? (isNew ? '' : shown?.instruction ?? '')
    const detailPath = isNew ? '/instructions' : instructionPath(instructionId)
    const nextVersion = (latest?.version ?? 0) + 1

    const save = async () => {
        if (!currentText.trim()) return
        setSaving(true)
        try {
            const created = await createInstruction(await getAccessTokenSilently(), {
                instruction: currentText,
                instructionName: currentName || undefined,
                existingInstructionId: isNew ? undefined : instructionId,
            })
            showToast(t('instructionDetail.page.saved', { version: created.version }))
            navigate(instructionPath(created.id), { replace: true })
        } catch (error) {
            console.error('Failed to save instruction', error)
            showToast(error instanceof ModerationError ? t('moderation.saveRefusedByFilter') : t('instructionDetail.instructionDetailPage.saveFailedAlert'))
        } finally {
            setSaving(false)
        }
    }

    const title = isNew ? t('instructionDetail.page.newTitle') : t('instructionDetail.page.editTitle')

    return (
        <DetailShell
            narrow={isNarrow}
            title={title}
            subtitle={!isNew && latest ? latest.name : undefined}
            breadcrumbs={[
                { label: t('instructionDetail.instructionDetailPage.breadcrumbInstructions'), onClick: () => navigate('/instructions') },
                ...(!isNew && latest ? [{ label: latest.name, onClick: () => navigate(detailPath) }] : []),
                { label: title },
            ]}
            back={{ label: isNew ? t('instructionDetail.page.backToList') : t('instructionDetail.page.back'), to: detailPath }}
            data-testid="instruction-edit-page"
        >
            {!isNew && loading && <div className={styles.state}>{t('instructionDetail.page.loading')}</div>}
            {(isNew || latest) && (
                <>
                    {older && shown && (
                        <div className={styles.banner} role="status">
                            {t('memoryPage.page.editingOlder', { version: shown.version, next: nextVersion })}
                        </div>
                    )}
                    <InputTextWithHint
                        hint={t('instructionDetail.instructionDetailPage.nameHint')}
                        placeholder={t('instructionDetail.instructionDetailPage.namePlaceholder')}
                        value={currentName}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
                    />
                    <TextEditor
                        id="instruction-edit-editor"
                        value={currentText}
                        onChange={setText}
                        disableCache
                        height={isNarrow ? '50vh' : '480px'}
                        fullWidth
                        data-testid="instruction-edit-text"
                    />
                    <div className={isNarrow ? styles.stickyActions : styles.desktopActions}>
                        <PillButton variant="secondary" label={t('instructionDetail.page.cancel')} onClick={() => navigate(detailPath)} disabled={saving} />
                        <PillButton
                            label={saving
                                ? t('instructionDetail.instructionDetailPage.savingLabel')
                                : isNew ? t('instructionDetail.page.create') : t('instructionDetail.page.save', { next: nextVersion })}
                            onClick={save}
                            disabled={saving || !currentText.trim()}
                            data-testid="instruction-save"
                        />
                    </div>
                </>
            )}
        </DetailShell>
    )
}
