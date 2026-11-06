import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { CustomerMemory, MemoryPlacement } from '../../../models/memory.models'
import { deleteMemory } from '../../../services/memoriesService'
import styles from '../MemoryPage.module.scss'

interface DeleteMemoryDialogProps {
    memory: CustomerMemory
    /** The placement it was opened from; a project memory shared with others can leave just that project. */
    from: MemoryPlacement
    onClose: () => void
    /** [deleted] is false when it only left the project. */
    onDone?: (deleted: boolean) => void
}

/** Confirms deleting a memory, or removing it from one of the projects that share it. */
export default function DeleteMemoryDialog({ memory, from, onClose, onDone }: DeleteMemoryDialogProps): React.ReactElement {
    const { t } = useTranslation()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const [busy, setBusy] = useState(false)
    const others = from.projectId ? memory.placements.filter(p => p.projectId !== from.projectId).length : 0

    const run = async (onlyHere: boolean) => {
        setBusy(true)
        try {
            const token = await getAccessTokenSilently()
            const deleted = await deleteMemory(token, memory.memoryId, onlyHere ? from.projectId ?? undefined : undefined)
            showToast(t(deleted ? 'memoryPage.delete.deleted' : 'memoryPage.delete.removed'))
            onDone?.(deleted)
            onClose()
        } catch (error) {
            console.error('Failed to delete memory:', error)
            showToast(t('memoryPage.delete.failed'))
        } finally {
            setBusy(false)
        }
    }

    const cancelButton = <PillButton variant="secondary" label={t('memoryPage.move.cancel')} onClick={onClose} disabled={busy} />
    const deleteButton = (
        <PillButton
            variant="danger"
            label={busy ? t('memoryPage.delete.deleting') : t(others > 0 ? 'memoryPage.delete.deleteEverywhere' : 'memoryPage.delete.delete')}
            onClick={() => run(false)}
            disabled={busy}
            data-testid="memory-delete-confirm"
        />
    )

    return (
        <Modal isOpen onClose={onClose} title={t('memoryPage.delete.title')} maxWidth="28rem">
            <div className={styles.dialog} data-testid="delete-memory-dialog">
                <p className={styles.dialogText}>
                    {others > 0 ? t('memoryPage.delete.sharedConfirm', { count: others }) : t('memoryPage.delete.confirm')}
                </p>
                {others > 0 ? (
                    // Three choices don't fit one row; a full-width stack reads the same on desktop and phones.
                    <div className={`${styles.dialogActions} ${styles.dialogActionsStacked}`}>
                        <PillButton
                            variant="secondary"
                            label={t('memoryPage.delete.removeHere')}
                            onClick={() => run(true)}
                            disabled={busy}
                            data-testid="memory-remove-here"
                        />
                        {deleteButton}
                        {cancelButton}
                    </div>
                ) : (
                    <div className={styles.dialogActions}>
                        {cancelButton}
                        {deleteButton}
                    </div>
                )}
            </div>
        </Modal>
    )
}
