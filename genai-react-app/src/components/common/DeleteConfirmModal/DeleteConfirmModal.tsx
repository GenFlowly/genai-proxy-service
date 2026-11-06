import React from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@genflowly/component-library'
import styles from './DeleteConfirmModal.module.scss'

interface DeleteConfirmModalProps {
    isOpen: boolean
    title: string
    message: string
    /** True while the delete runs: both buttons are disabled and the dialog can't be dismissed. */
    isDeleting: boolean
    /** Why the last attempt failed; the dialog stays open to try again. */
    error?: string | null
    onConfirm: () => void
    onCancel: () => void
    'data-testid'?: string
}

/** Asks before a permanent delete. */
export function DeleteConfirmModal({
    isOpen,
    title,
    message,
    isDeleting,
    error,
    onConfirm,
    onCancel,
    'data-testid': testId = 'delete-confirm',
}: DeleteConfirmModalProps): React.ReactElement {
    const { t } = useTranslation()
    return (
        <Modal isOpen={isOpen} onClose={() => { if (!isDeleting) onCancel() }} title={title} maxWidth="26rem">
            <div className={styles.body} data-testid={testId}>
                <p className={styles.message}>{message}</p>
                {error && <p className={styles.error} role="alert">{error}</p>}
                <div className={styles.actions}>
                    <button
                        type="button"
                        className={styles.cancel}
                        onClick={onCancel}
                        disabled={isDeleting}
                        data-testid={`${testId}-cancel`}
                    >
                        {t('common.deleteConfirm.cancel')}
                    </button>
                    <button
                        type="button"
                        className={styles.confirm}
                        onClick={onConfirm}
                        disabled={isDeleting}
                        data-testid={`${testId}-confirm`}
                    >
                        {isDeleting ? t('common.deleteConfirm.deleting') : t('common.deleteConfirm.delete')}
                    </button>
                </div>
            </div>
        </Modal>
    )
}
