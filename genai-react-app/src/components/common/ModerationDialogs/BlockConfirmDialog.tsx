import React from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton } from '@genflowly/component-library'
import styles from './ModerationDialogs.module.scss'

interface BlockConfirmDialogProps {
    isOpen: boolean
    /** Who is being blocked, as shown to the person blocking them. */
    name: string
    blocking: boolean
    error: string | null
    onConfirm: () => void
    onCancel: () => void
}

/** Blocking removes shares, so the menu action asks first. */
export function BlockConfirmDialog({ isOpen, name, blocking, error, onConfirm, onCancel }: BlockConfirmDialogProps): React.ReactElement {
    const { t } = useTranslation()
    return (
        <Modal isOpen={isOpen} onClose={() => { if (!blocking) onCancel() }} title={t('moderation.block.title', { name })} maxWidth="26rem">
            <div className={styles.confirmBody} data-testid="block-confirm">
                <p className={styles.message}>{t('moderation.block.message')}</p>
                {error && <p className={styles.error} role="alert">{error}</p>}
                <div className={styles.actions}>
                    <PillButton variant="secondary" label={t('moderation.block.cancel')} onClick={onCancel} disabled={blocking} />
                    <button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={blocking} data-testid="block-confirm-button">
                        {blocking ? t('moderation.block.blocking') : t('moderation.block.confirm')}
                    </button>
                </div>
            </div>
        </Modal>
    )
}
