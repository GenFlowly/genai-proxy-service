import React, {useEffect} from 'react'
import {useTranslation} from 'react-i18next'
import {ICONS} from '../../../../constants/icons'
import { TextEditor } from '@genflowly/component-library'
import { RectangleButton } from '@genflowly/component-library'
import { Tooltip } from '@genflowly/component-library'
import { Icon } from '@genflowly/component-library'
import {useConversation, useConversationUI} from '../../../../context/ConversationContext'
import {useAuth} from '../../../../context/AuthContext'
import {useToast} from '../../../../context/ToastContext'
import { TextContainer } from '@genflowly/component-library'
import styles from './Request.module.scss'
import {
    UserBrandName
} from '../../../common/BrandName/BrandName'
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
import {useWindowSize} from '../../../../hooks/useWindowSize'

interface RequestProps {
    blockId: string
}

// Memoized (see export): props are stable, so re-renders come only from its
// own editing state and the contexts it subscribes to
function Request({
                     blockId,
                     'data-testid': testId
                 }: RequestProps & { 'data-testid'?: string }) {
    const {t} = useTranslation()
    const {
        conversationBlockList,
        generateResponsesStream,
        getSelectedResponseForBlock,
        setActiveBlockId
    } = useConversation()
    const { setEditorPrompt } = useConversationUI()

    const {
        aiVendorAPIKeyStatusList,
        customerName,
        customerPicture,
        user,
        getAccessTokenSilently
    } = useAuth()
    const {showToast} = useToast()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)
    const {width} = useWindowSize()
    const isMobile = width <= 768

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === blockId)
    // The prompt editor renders unless the block is streaming/resolved
    const isEditorView = !!conversationBlock
        && conversationBlock.status !== 'resolved'
        && !conversationBlock.isLoading
    // Any block after the first is a follow-up: same docked editor, but the
    // block only occupies the editor's height on mobile, not a full screen
    const isFollowUpBlock = conversationBlockList.findIndex(b => b.conversationBlockId === blockId) > 0

    const editorWrapperRef = React.useRef<HTMLDivElement | null>(null)

    // 📱 A focused follow-up block grows by the keyboard's height (--kb in
    // the SCSS) so the riding editor gets reserved space instead of
    // overlapping the response above. That growth happens at the END of the
    // scroll content — keep the conversation pinned to the end whenever the
    // keyboard opens/closes so the editor lands flush on the keyboard with
    // the last response visible right above it.
    useEffect(() => {
        if (!isEditorView || !isFollowUpBlock) return
        const viewport = window.visualViewport
        if (!viewport) return

        const scrollConversationToEnd = () => {
            const scroller = document.querySelector('[data-testid="center-section-scroll"]')
            if (scroller) scroller.scrollTop = scroller.scrollHeight
        }

        const handleResize = () => {
            if (!editorWrapperRef.current?.contains(document.activeElement)) return
            // Double rAF: the --vvh/--kb CSS vars are themselves written in a
            // rAF, so wait a frame for the block's new height to apply first
            requestAnimationFrame(() => requestAnimationFrame(scrollConversationToEnd))
        }

        viewport.addEventListener('resize', handleResize)
        return () => viewport.removeEventListener('resize', handleResize)
    }, [isEditorView, isFollowUpBlock])

    // 📱 iOS Safari force-scrolls the page on focus when it thinks the
    // keyboard will cover the caret — before our CSS has moved the editor up
    // — which shoves the whole layout (incl. the fixed MobileHeader) off
    // screen. The editor repositions itself above the keyboard, so the
    // scroll is never needed: pin the window scroll back to 0 during the
    // keyboard animation and whenever Safari retries while the editor owns
    // focus. No-op everywhere else (the window never scrolls in this app).
    useEffect(() => {
        if (!isEditorView) return
        const wrapper = editorWrapperRef.current
        if (!wrapper) return

        let rafId: number | null = null
        let pinUntil = 0

        const pin = () => {
            rafId = null
            if (window.scrollY !== 0) window.scrollTo(0, 0)
            if (performance.now() < pinUntil) {
                rafId = requestAnimationFrame(pin)
            }
        }
        const startPinning = (durationMs: number) => {
            pinUntil = Math.max(pinUntil, performance.now() + durationMs)
            if (rafId === null) rafId = requestAnimationFrame(pin)
        }

        // Cover the whole keyboard open/close animation (~250ms on iOS);
        // focusout catches the close-side pan Safari does while restoring
        const handleFocusChange = () => startPinning(700)
        // Safari can re-scroll later (e.g. caret moves); undo while focused
        const handleScroll = () => {
            if (wrapper.contains(document.activeElement)) startPinning(150)
        }

        wrapper.addEventListener('focusin', handleFocusChange)
        wrapper.addEventListener('focusout', handleFocusChange)
        window.addEventListener('scroll', handleScroll)
        window.visualViewport?.addEventListener('scroll', handleScroll)
        return () => {
            wrapper.removeEventListener('focusin', handleFocusChange)
            wrapper.removeEventListener('focusout', handleFocusChange)
            window.removeEventListener('scroll', handleScroll)
            window.visualViewport?.removeEventListener('scroll', handleScroll)
            if (rafId !== null) cancelAnimationFrame(rafId)
        }
    }, [isEditorView])

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

    // Mobile file-picker path: same validation/upload pipeline as paste.
    const attachmentInputRef = React.useRef<HTMLInputElement>(null)
    const handleAttachmentInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        Array.from(e.target.files ?? []).forEach(uploadPastedImage)
        // Allow re-selecting the same file later
        e.target.value = ''
    }, [uploadPastedImage])

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

    const handleGenerate = () => {
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
    }

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

        <div className={`${styles.container}${isFollowUpBlock ? ` ${styles.followUp}` : ''}`}
             onPasteCapture={handlePasteCapture}
             data-testid={testId || "request-widget-container"}>
            <div className={styles.editorWrapper} ref={editorWrapperRef}>
                <TextEditor
                    id={blockId}
                    value={draftPrompt}
                    onChange={handleEditorChange}
                    height="100%"
                    className={styles.textEditorFullscreen}
                    data-testid="text-editor"
                />

                {isMobile && (
                    // 📱 Compact icon-only generate button floating inside the
                    // editor's bottom-right corner
                    <button
                        className={styles.mobileGenerateButton}
                        onClick={handleGenerate}
                        disabled={!hasAnyValidApiKey}
                        aria-label={t('conversation.request.generate')}
                        data-testid="generate-button"
                    >
                        <Icon src={ICONS.SEND} size={22}/>
                    </button>
                )}

                {isMobile && (
                    // 📱 Image-attachment picker to the LEFT of the generate
                    // button — mobile has no paste path for images, so this is
                    // the only way to attach them there. Desktop stays
                    // paste-only for now.
                    <>
                        <input
                            ref={attachmentInputRef}
                            type="file"
                            accept={ALLOWED_ATTACHMENT_MEDIA_TYPES.join(',')}
                            multiple
                            hidden
                            onChange={handleAttachmentInputChange}
                            data-testid="attachment-file-input"
                        />
                        <button
                            className={styles.mobileAttachmentButton}
                            onClick={() => attachmentInputRef.current?.click()}
                            aria-label={t('conversation.request.addImageAttachment')}
                            data-testid="attachment-button"
                        >
                            <Icon src={ICONS.IMAGE_ATTACHMENT} size={22}/>
                        </button>
                    </>
                )}

                <AttachmentPreviewStrip
                    attachments={pendingAttachments}
                    onRemove={removeAttachment}
                />
            </div>

            {!isMobile && (
                <div className={styles.buttonWrapper}
                     data-testid="generate-button-wrapper">
                    <Tooltip content={!hasAnyValidApiKey ? t('conversation.request.noApiKeysSet') : ""}>
                        <div
                            style={!hasAnyValidApiKey ? {cursor: 'not-allowed'} : {}}>
                            <RectangleButton
                                onClick={handleGenerate}
                                label={t('conversation.request.generate')}
                                disabled={!hasAnyValidApiKey}
                                icon={ICONS.SEND}
                                data-testid="generate-button"
                            />
                        </div>
                    </Tooltip>
                </div>
            )}
        </div>
    )
}

export default React.memo(Request)
