import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { Modal, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useResponsiveBreakpoints } from '../../../hooks/useResponsiveBreakpoints'
import {
    REPORT_DETAILS_MAX_CHARS,
    REPORT_REASONS,
    ReportReason,
    ReportedEntityType,
    reportContent,
} from '../../../services/moderationService'
import { ContentRulesLink } from './ContentRulesLink'
import styles from './ModerationDialogs.module.scss'

interface ReportDialogProps {
    isOpen: boolean
    onClose: () => void
    entityType: ReportedEntityType
    entityId: string
    ownerLabel: string
    canBlock: boolean
    canRemove: boolean
    onBlock: () => void
    blocking: boolean
    blockError: string | null
    onRemove: () => void
}

/** A dialog on desktop and a bottom sheet on phones: why an item is being reported, then what to do next. */
export function ReportDialog({
    isOpen, onClose, entityType, entityId, ownerLabel, canBlock, canRemove, onBlock, blocking, blockError, onRemove,
}: ReportDialogProps): React.ReactElement | null {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    const { getAccessTokenSilently } = useAuth()
    const [reason, setReason] = useState<ReportReason | null>(null)
    const [details, setDetails] = useState('')
    const [sending, setSending] = useState(false)
    const [failed, setFailed] = useState(false)
    const [sent, setSent] = useState(false)

    useEffect(() => {
        if (!isOpen) return
        setReason(null)
        setDetails('')
        setFailed(false)
        setSent(false)
    }, [isOpen, entityId])

    const send = async () => {
        if (!reason) return
        setSending(true)
        setFailed(false)
        try {
            const trimmed = details.trim()
            await reportContent(await getAccessTokenSilently(), {
                entityType, entityId, reason, ...(trimmed ? { details: trimmed } : {}),
            })
            setSent(true)
        } catch (error) {
            console.error('Failed to send report', error)
            setFailed(true)
        } finally {
            setSending(false)
        }
    }

    const isConversation = entityType === 'CONVERSATION'
    const title = sent
        ? t('moderation.report.sentTitle')
        : t(isConversation ? 'moderation.report.titleConversation' : 'moderation.report.titleInstruction')
    const rulesLink = <ContentRulesLink className={styles.link} />

    const form = (
        <div className={styles.form} data-testid="report-form">
            <p className={styles.subtitle}>{t('moderation.report.sharedBy', { name: ownerLabel })}</p>
            <div className={styles.reasons} role="radiogroup" aria-label={t('moderation.report.reasonsLabel')}>
                {REPORT_REASONS.map(value => (
                    <label key={value} className={`${styles.reason} ${reason === value ? styles.reasonSelected : ''}`}>
                        <span>{t(`moderation.report.reasons.${value}`)}</span>
                        <input
                            type="radio"
                            name="report-reason"
                            checked={reason === value}
                            onChange={() => setReason(value)}
                            data-testid={`report-reason-${value}`}
                        />
                    </label>
                ))}
            </div>
            <label className={styles.fieldLabel} htmlFor="report-details">{t('moderation.report.detailsLabel')}</label>
            <textarea
                id="report-details"
                className={styles.details}
                placeholder={t('moderation.report.detailsPlaceholder')}
                value={details}
                maxLength={REPORT_DETAILS_MAX_CHARS}
                onChange={event => setDetails(event.target.value)}
                data-testid="report-details"
            />
            <p className={styles.note}>
                <Trans i18nKey="moderation.report.note" components={{ rules: rulesLink }} />
            </p>
            {failed && <p className={styles.error} role="alert">{t('moderation.report.failed')}</p>}
            <div className={`${styles.actions} ${isNarrow ? styles.actionsStacked : ''}`}>
                {!isNarrow && <PillButton variant="secondary" label={t('moderation.report.cancel')} onClick={onClose} disabled={sending} />}
                <PillButton
                    label={sending ? t('moderation.report.sending') : t('moderation.report.send')}
                    onClick={send}
                    disabled={sending || !reason}
                    data-testid="report-send"
                />
                {isNarrow && <PillButton variant="secondary" label={t('moderation.report.cancel')} onClick={onClose} disabled={sending} />}
            </div>
        </div>
    )

    const confirmation = (
        <div className={styles.sent} data-testid="report-sent">
            <div className={styles.sentHead}>
                <span className={styles.sentIcon}><Check size={28} strokeWidth={2.25} aria-hidden="true" /></span>
                {isNarrow && <h2 className={styles.sentTitle}>{t('moderation.report.sentTitle')}</h2>}
                <p className={styles.sentBody}>{t('moderation.report.sentBody')}</p>
            </div>
            {canBlock && (
                <div className={styles.followUp}>
                    <div className={styles.followUpText}>
                        <strong>{t('moderation.report.blockTitle', { name: ownerLabel })}</strong>
                        <span>{t('moderation.report.blockBody')}</span>
                    </div>
                    <button type="button" className={styles.dangerPill} onClick={onBlock} disabled={blocking} data-testid="report-block">
                        {t('moderation.report.blockButton')}
                    </button>
                </div>
            )}
            {canRemove && (
                <div className={styles.followUp}>
                    <div className={styles.followUpText}>
                        <strong>{t('moderation.report.removeTitle')}</strong>
                        <span>{t(isConversation ? 'moderation.report.removeBodyConversation' : 'moderation.report.removeBodyInstruction')}</span>
                    </div>
                    <button type="button" className={styles.plainPill} onClick={onRemove} data-testid="report-remove">
                        {t('moderation.report.removeButton')}
                    </button>
                </div>
            )}
            {blockError && <p className={styles.error} role="alert">{blockError}</p>}
            <div className={`${styles.actions} ${isNarrow ? styles.actionsStacked : ''}`}>
                <PillButton label={t('moderation.report.done')} onClick={onClose} data-testid="report-done" />
            </div>
        </div>
    )

    if (!isOpen) return null
    const body = sent ? confirmation : form

    if (!isNarrow) {
        return <Modal isOpen onClose={onClose} title={title} maxWidth="30rem">{body}</Modal>
    }

    return createPortal(
        <div className={styles.sheetOverlay} onClick={onClose} data-testid="report-sheet">
            <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
                <div className={styles.sheetHandle} aria-hidden="true" />
                {!sent && <h2 className={styles.sheetTitle}>{title}</h2>}
                {body}
            </div>
        </div>,
        document.body
    )
}
