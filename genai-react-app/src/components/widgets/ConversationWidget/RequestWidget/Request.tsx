import React, {useEffect} from 'react'
import {useTranslation} from 'react-i18next'
import {ICONS} from '../../../../constants/icons'
import { TextEditor } from '@genflowly/component-library'
import { MultiPurposeButton } from '@genflowly/component-library'
import { Tooltip } from '@genflowly/component-library'
import {useConversation} from '../../../../context/ConversationContext'
import {useAuth} from '../../../../context/AuthContext'
import {useToast} from '../../../../context/ToastContext'
import { TextContainer } from '@genflowly/component-library'
import styles from './Request.module.scss'
import { UserBrandName } from '@genflowly/component-library'
import {formatServerDateTime} from '../../../../utils/timeUtils'
import AttachmentPreviewStrip, {
    PendingAttachment,
    ResolvedAttachmentThumbnails
} from './AttachmentPreviewStrip'
import {uploadAttachment} from '../../../../services/attachmentService'
import {
    ALLOWED_ATTACHMENT_MEDIA_TYPES,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_ATTACHMENT_SIZE_BYTES
} from '../../../../models/attachment.models'

interface RequestProps {
    blockId: string
}

export default function Request({
                                    blockId,
                                    'data-testid': testId
                                }: RequestProps & { 'data-testid'?: string }) {
    const {t} = useTranslation()
    const {
        conversationBlockList,
        generateResponsesStream,
        getSelectedResponseForBlock,
        setEditorPrompt,
        setActiveBlockId
    } = useConversation()

    const {
        aiVendorAPIKeyStatusList,
        customerName,
        customerPicture,
        user,
        getAccessTokenSilently
    } = useAuth()
    const {showToast} = useToast()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === blockId)

    // ✅ Local draft state to prevent global re-renders on typing
    const [draftPrompt, setDraftPrompt] = React.useState(conversationBlock?.prompt || '')

    // Images pasted into the editor; uploaded to S3 in the background
    const [pendingAttachments, setPendingAttachments] = React.useState<PendingAttachment[]>([])
    const pendingAttachmentsRef = React.useRef(pendingAttachments)
    pendingAttachmentsRef.current = pendingAttachments

    // Revoke preview object URLs on unmount
    useEffect(() => {
        return () => {
            pendingAttachmentsRef.current.forEach(a => URL.revokeObjectURL(a.previewUrl))
        }
    }, [])

    const removeAttachment = React.useCallback((localId: string) => {
        setPendingAttachments(prev => {
            const target = prev.find(a => a.localId === localId)
            if (target) URL.revokeObjectURL(target.previewUrl)
            return prev.filter(a => a.localId !== localId)
        })
    }, [])

    const uploadPastedImage = React.useCallback(async (file: File) => {
        if (!ALLOWED_ATTACHMENT_MEDIA_TYPES.includes(file.type)) {
            showToast(t('conversation.request.attachmentUnsupportedType'))
            return
        }
        if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
            showToast(t('conversation.request.attachmentTooLarge'))
            return
        }
        if (pendingAttachmentsRef.current.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
            showToast(t('conversation.request.attachmentLimitReached', {max: MAX_ATTACHMENTS_PER_MESSAGE}))
            return
        }

        const localId = `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const previewUrl = URL.createObjectURL(file)
        setPendingAttachments(prev => [...prev, {
            localId,
            fileName: file.name || 'pasted-image',
            previewUrl,
            status: 'uploading'
        }])

        try {
            const token = await getAccessTokenSilently()
            const ref = await uploadAttachment(token, file)
            setPendingAttachments(prev => prev.map(a =>
                a.localId === localId ? {...a, status: 'ready', ref} : a
            ))
        } catch (err) {
            console.error('Attachment upload failed:', err)
            showToast(t('conversation.request.attachmentUploadFailed'))
            removeAttachment(localId)
        }
    }, [getAccessTokenSilently, removeAttachment, showToast, t])

    // GitHub-style paste: an image in the clipboard uploads automatically,
    // no file picker involved. Capture phase so the markdown editor doesn't
    // swallow the event first.
    const handlePasteCapture = React.useCallback((e: React.ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.items ?? [])
            .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
            .map(item => item.getAsFile())
            .filter((f): f is File => f !== null)

        if (files.length === 0) return

        e.preventDefault()
        e.stopPropagation()
        files.forEach(uploadPastedImage)
    }, [uploadPastedImage])

    // Dependencies moved from TextEditor
    const {customerId} = useAuth()
    const storageTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const contextTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const STORAGE_KEY = customerId ? `${customerId}_prompt_editor_content_conv-${blockId}` : ''

    // Load from localStorage only on mount if empty
    useEffect(() => {
        if (!STORAGE_KEY) return

        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved && !draftPrompt) {
                setDraftPrompt(saved)
                // Also sync to parent/global if needed, but usually we wait for user action
                // actually, if we load from storage, we should probably update the draft
            }
        } catch (err) {
            console.error('Failed to load from localStorage:', err)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Sync draft if global prompt changes (e.g. history load or API success)
    useEffect(() => {
        if (conversationBlock?.prompt && conversationBlock.prompt !== draftPrompt) {
            setDraftPrompt(conversationBlock.prompt)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationBlock?.prompt])

    // ✅ Sync AI Context on mount (or when blockId changes)
    // This restores the logic previously in TextEditor that ensures
    // the Token Counter knows about this block immediately.
    useEffect(() => {
        // Only sync if we are the "active" editing block (no responses yet)
        if (conversationBlock?.responseMessages.length === 0) {
            setActiveBlockId(blockId)
            setEditorPrompt(draftPrompt)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blockId]) // Run on mount/id change

    const handleEditorChange = React.useCallback((newValue: string) => {
        // Ensure we are the active block
        setActiveBlockId(blockId)

        // Immediate UI update via local state
        setDraftPrompt(newValue)

        // Debounce localStorage
        if (storageTimerRef.current) clearTimeout(storageTimerRef.current)
        storageTimerRef.current = setTimeout(() => {
            try {
                if (STORAGE_KEY) {
                    localStorage.setItem(STORAGE_KEY, newValue)
                }
            } catch (err) {
                console.error(err)
            }
        }, 500)

        // Debounce Context (Token Counting)
        if (contextTimerRef.current) clearTimeout(contextTimerRef.current)
        contextTimerRef.current = setTimeout(() => {
            setEditorPrompt(newValue)
        }, 500)
    }, [blockId, setActiveBlockId, setEditorPrompt, STORAGE_KEY])

    // Cleanup timers
    useEffect(() => {
        return () => {
            if (storageTimerRef.current) clearTimeout(storageTimerRef.current)
            if (contextTimerRef.current) clearTimeout(contextTimerRef.current)
        }
    }, [])

    if (!conversationBlock) return null

    // If we have responses AND loading is finished, this block is "resolved" -> Show static text
    // (Stopping an in-flight generation is done per-vendor from the Response widget.)
    const displayName = customerName || user?.name || ''
    const displayPicture = customerPicture || user?.picture

    // Only lock Request when actively streaming/resolved AND not being edited
    if (conversationBlock.status === 'resolved' || conversationBlock.isLoading) {
        // The request card spans the total max allowed width of the response
        // columns below it (N columns + the gaps between them)
        const responseColumnCount = Math.max(1, conversationBlock.responseMessages.length)
        return (
            <div className={styles.resolvedRequestContainer}
                 style={{ '--response-column-count': responseColumnCount } as React.CSSProperties}
                 data-testid={testId || "resolved-request-wrapper"}>
                <TextContainer
                    className={styles.requestWrapper}
                    content={conversationBlock.prompt}
                    title={<UserBrandName name={displayName}
                                          picture={displayPicture} as="span"/>}
                    showCopyButton={true}
                    data-testid={testId || "resolved-request-wrapper"}
                >
                    {(conversationBlock.attachments?.length ?? 0) > 0 && (
                        <ResolvedAttachmentThumbnails attachments={conversationBlock.attachments!} />
                    )}
                    {conversationBlock.sentAt && (
                        <div className={styles.sentTimestamp}
                             data-testid="request-sent-timestamp">
                            {formatServerDateTime(conversationBlock.sentAt)}
                        </div>
                    )}
                </TextContainer>
            </div>
        )
    }

    // Otherwise show the editor
    return (

        <div className={styles.container}
             onPasteCapture={handlePasteCapture}
             data-testid={testId || "request-widget-container"}>
            <TextEditor
                id={blockId}
                value={draftPrompt}
                onChange={handleEditorChange}
                height="100%"
                className={styles.textEditorFullscreen}
                data-testid="text-editor"
            />

            <AttachmentPreviewStrip
                attachments={pendingAttachments}
                onRemove={removeAttachment}
            />

            <div className={styles.buttonWrapper}
                 data-testid="generate-button-wrapper">
                <Tooltip content={!hasAnyValidApiKey ? t('conversation.request.noApiKeysSet') : ""}>
                    <div
                        style={!hasAnyValidApiKey ? {cursor: 'not-allowed'} : {}}>
                        <MultiPurposeButton
                            onClick={() => {
                                if (!hasAnyValidApiKey) return
                                if (pendingAttachments.some(a => a.status === 'uploading')) {
                                    showToast(t('conversation.request.attachmentsUploading'))
                                    return
                                }
                                const selectedId = getSelectedResponseForBlock(blockId)
                                const attachmentRefs = pendingAttachments
                                    .map(a => a.ref)
                                    .filter((r): r is NonNullable<typeof r> => r != null)
                                generateResponsesStream(blockId, draftPrompt, selectedId, undefined, attachmentRefs)
                                // The block now owns the refs; drop the local previews
                                pendingAttachments.forEach(a => URL.revokeObjectURL(a.previewUrl))
                                setPendingAttachments([])
                            }}
                            label={t('conversation.request.generate')}
                            disabled={!hasAnyValidApiKey}
                            icon={ICONS.SEND}
                            data-testid="generate-button"
                        />
                    </div>
                </Tooltip>
            </div>
        </div>
    )
}
