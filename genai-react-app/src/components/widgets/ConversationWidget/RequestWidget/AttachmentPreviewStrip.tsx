import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AttachmentRef } from '../../../../models/attachment.models'
import { getAttachmentViewUrl } from '../../../../services/attachmentService'
import { useAuth } from '../../../../context/AuthContext'
import styles from './AttachmentPreview.module.scss'

/** An image being attached in the editor: uploads to S3 in the background after paste. */
export interface PendingAttachment {
    localId: string
    fileName: string
    /** Object URL of the pasted file, for instant preview */
    previewUrl: string
    status: 'uploading' | 'ready'
    ref?: AttachmentRef
}

interface AttachmentPreviewStripProps {
    attachments: PendingAttachment[]
    onRemove: (localId: string) => void
}

/** Thumbnail strip shown at the bottom of the request editor while composing. */
export default function AttachmentPreviewStrip({ attachments, onRemove }: AttachmentPreviewStripProps): React.ReactElement | null {
    const { t } = useTranslation()

    if (attachments.length === 0) return null

    return (
        <div className={styles.strip} data-testid="attachment-preview-strip">
            {attachments.map(attachment => (
                <div
                    key={attachment.localId}
                    className={`${styles.thumbWrapper} ${attachment.status === 'uploading' ? styles.uploading : ''}`}
                    data-testid="attachment-thumbnail"
                >
                    <img src={attachment.previewUrl} alt={attachment.fileName} className={styles.thumb} />
                    {attachment.status === 'uploading' && (
                        <div className={styles.spinnerOverlay} data-testid="attachment-uploading-spinner">
                            <div className={styles.spinner} />
                        </div>
                    )}
                    <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => onRemove(attachment.localId)}
                        aria-label={t('conversation.request.removeAttachment')}
                        title={t('conversation.request.removeAttachment')}
                        data-testid="attachment-remove-button"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    )
}

interface ResolvedAttachmentThumbnailsProps {
    attachments: AttachmentRef[]
}

/**
 * Read-only thumbnails on resolved request cards (and conversations loaded
 * from history). Renders via short-lived presigned S3 GET URLs.
 */
export function ResolvedAttachmentThumbnails({ attachments }: ResolvedAttachmentThumbnailsProps): React.ReactElement | null {
    const { getAccessTokenSilently, isAuthenticated } = useAuth()
    const [urls, setUrls] = useState<Record<string, string>>({})

    useEffect(() => {
        if (!isAuthenticated || attachments.length === 0) return
        let cancelled = false

        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const entries = await Promise.all(
                    attachments.map(async attachment => {
                        try {
                            const url = await getAttachmentViewUrl(token, attachment.attachmentId)
                            return [attachment.attachmentId, url] as const
                        } catch {
                            return null
                        }
                    })
                )
                if (!cancelled) {
                    setUrls(Object.fromEntries(entries.filter((e): e is readonly [string, string] => e !== null)))
                }
            } catch (err) {
                console.warn('Failed to load attachment URLs', err)
            }
        }
        load()

        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attachments.map(a => a.attachmentId).join(','), isAuthenticated])

    if (attachments.length === 0) return null

    const loaded = attachments.filter(a => urls[a.attachmentId])
    if (loaded.length === 0) return null

    return (
        <div className={styles.resolvedStrip} data-testid="resolved-attachment-strip">
            {loaded.map(attachment => (
                <img
                    key={attachment.attachmentId}
                    src={urls[attachment.attachmentId]}
                    alt=""
                    className={styles.resolvedThumb}
                    onClick={() => window.open(urls[attachment.attachmentId], '_blank', 'noopener')}
                    data-testid="resolved-attachment-thumbnail"
                />
            ))}
        </div>
    )
}
