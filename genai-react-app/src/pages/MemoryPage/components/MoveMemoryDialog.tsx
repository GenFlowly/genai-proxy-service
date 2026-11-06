import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { Project } from '../../../models/conversationHistory.models'
import { CustomerMemory, MemoryKind, MemoryPlacement, isProfileMemory } from '../../../models/memory.models'
import { MemoryApiError, copyMemory, moveMemory } from '../../../services/memoriesService'
import { kindHelp, kindLabel, placementLabel, projectNames } from '../memoryLabels'
import KindToggle from './KindToggle'
import styles from '../MemoryPage.module.scss'

const PROFILE = 'profile'

interface MoveMemoryDialogProps {
    memory: CustomerMemory
    initialMode: 'move' | 'copy'
    /** The placement the dialog was opened from: the list or detail page's scope. */
    from: MemoryPlacement
    projects: Project[]
    onClose: () => void
    onDone?: (memory: CustomerMemory) => void
}

/**
 * Move changes where a memory applies; copy (project memories only) adds
 * another project that shares the same memory. Neither touches its versions
 * or change log.
 */
export default function MoveMemoryDialog({
    memory,
    initialMode,
    from,
    projects,
    onClose,
    onDone,
}: MoveMemoryDialogProps): React.ReactElement {
    const { t } = useTranslation()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const canCopy = !isProfileMemory(memory)
    const [mode, setMode] = useState<'move' | 'copy'>(canCopy ? initialMode : 'move')
    const [target, setTarget] = useState<string | null>(null)
    const [kind, setKind] = useState<MemoryKind>(from.kind)
    const [saving, setSaving] = useState(false)
    const names = useMemo(() => projectNames(projects), [projects])
    const isMove = mode === 'move'

    const targetProjects = projects.filter(project =>
        isMove || !memory.placements.some(p => p.projectId === project.projectId))
    const fromKey = from.projectId ?? PROFILE
    const unchanged = isMove && target === fromKey && kind === from.kind
    const ready = target !== null && !unchanged
    const place = target === PROFILE ? t('memoryPage.scopes.profile') : target ? names[target] ?? '' : ''

    const explain = !isMove
        ? t('memoryPage.move.copyExplain')
        : target === PROFILE && from.projectId
            ? t('memoryPage.move.moveToProfileExplain')
            : t('memoryPage.move.moveExplain')

    const submit = async () => {
        if (!ready || !target) return
        setSaving(true)
        try {
            const token = await getAccessTokenSilently()
            const updated = isMove
                ? await moveMemory(token, memory.memoryId, from.projectId ?? null, target === PROFILE ? null : target, kind)
                : await copyMemory(token, memory.memoryId, from.projectId!, target, kind)
            showToast(t(isMove ? 'memoryPage.move.moved' : 'memoryPage.move.copied'))
            onDone?.(updated)
            onClose()
        } catch (error) {
            console.error('Failed to move memory:', error)
            showToast(t(error instanceof MemoryApiError && error.status === 409
                ? 'memoryPage.detail.conflict'
                : 'memoryPage.move.failed'))
        } finally {
            setSaving(false)
        }
    }

    const destination = (key: string, label: string) => {
        const here = isMove && memory.placements.find(p => (p.projectId ?? PROFILE) === key)
        return (
            <label key={key} className={`${styles.destination} ${target === key ? styles.destinationOn : ''}`}>
                <input
                    type="radio"
                    name="memory-destination"
                    checked={target === key}
                    onChange={() => setTarget(key)}
                    data-testid={`memory-destination-${key}`}
                />
                <span className={styles.destinationLabel}>{label}</span>
                {here && <span className={styles.destinationNote}>{t('memoryPage.move.currentlyHere', { kind: kindLabel(here.kind) })}</span>}
            </label>
        )
    }

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t(isMove ? 'memoryPage.move.moveTitle' : 'memoryPage.move.copyTitle')}
            maxWidth="31rem"
        >
            <div className={styles.dialog} data-testid="move-memory-dialog">
                <div className={styles.dialogMemory}>
                    <p className={styles.dialogText}>{memory.text}</p>
                    <p className={styles.dialogMeta}>{t('memoryPage.move.appliesIn', { place: placementLabel(from, names) })}</p>
                </div>

                {canCopy && (
                    <div className={styles.segmented} role="group" aria-label={t('memoryPage.move.mode')}>
                        {(['move', 'copy'] as const).map(option => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={mode === option}
                                className={`${styles.segment} ${mode === option ? styles.segmentOn : ''}`}
                                onClick={() => {
                                    setMode(option)
                                    setTarget(null)
                                }}
                                data-testid={`memory-mode-${option}`}
                            >
                                {t(`memoryPage.move.${option}`)}
                            </button>
                        ))}
                    </div>
                )}
                <p className={styles.help}>{explain}</p>

                <fieldset className={styles.destinations}>
                    <legend className={styles.fieldLabel}>{t('memoryPage.move.whereItApplies')}</legend>
                    {isMove && destination(PROFILE, t('memoryPage.scopes.profile'))}
                    {targetProjects.map(project => destination(project.projectId, project.name))}
                    {!isMove && targetProjects.length === 0 && (
                        <p className={styles.help}>{t('memoryPage.move.noOtherProjects')}</p>
                    )}
                </fieldset>

                <div className={styles.field}>
                    <span className={styles.fieldLabel} id="memory-move-kind">{t('memoryPage.move.kind')}</span>
                    <KindToggle value={kind} onChange={setKind} labelledBy="memory-move-kind" />
                    <p className={styles.help}>{kindHelp(kind, !!target && target !== PROFILE)}</p>
                </div>

                <div className={styles.dialogActions}>
                    <PillButton variant="secondary" label={t('memoryPage.move.cancel')} onClick={onClose} disabled={saving} />
                    <PillButton
                        label={unchanged
                            ? t('memoryPage.move.alreadyHere')
                            : target
                                ? t(isMove ? 'memoryPage.move.confirmMove' : 'memoryPage.move.confirmCopy', { place, kind: kindLabel(kind) })
                                : t('memoryPage.move.chooseWhere')}
                        onClick={submit}
                        disabled={!ready || saving}
                        data-testid="memory-move-confirm"
                    />
                </div>
            </div>
        </Modal>
    )
}
