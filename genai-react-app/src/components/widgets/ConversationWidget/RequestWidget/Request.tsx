import React, {useEffect} from 'react'
import {ICONS} from '../../../../constants/icons'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton
    from '../../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../../common/Tooltip/Tooltip'
import {useConversation} from '../../../../context/ConversationContext'
import {useAuth} from '../../../../context/AuthContext'
import TextContainer from '../../../common/TextContainer/TextContainer'
import styles from './Request.module.scss'
import {
    UserBrandName
} from '../../../common/BrandName/BrandName'

interface RequestProps {
    blockId: string
}

export default function Request({
                                    blockId,
                                    'data-testid': testId
                                }: RequestProps & { 'data-testid'?: string }) {
    const {
        conversationBlockList,
        generateResponsesStream,
        stopGenerating,
        getSelectedResponseForBlock,
        setEditorPrompt,
        setActiveBlockId
    } = useConversation()

    const {
        aiVendorAPIKeyStatusList,
        customerName,
        customerPicture,
        user
    } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === blockId)

    // ✅ Local draft state to prevent global re-renders on typing
    const [draftPrompt, setDraftPrompt] = React.useState(conversationBlock?.prompt || '')

    // Dependencies moved from PromptEditor
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
    // This restores the logic previously in PromptEditor that ensures
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
    // We keep the editor visible during loading so the user sees the "Stop Generating" button state.
    const displayName = customerName || user?.name || ''
    const displayPicture = customerPicture || user?.picture

    // Only lock Request when actively streaming/resolved AND not being edited
    if (conversationBlock.status === 'resolved' || conversationBlock.isLoading) {
        return (
            <div className={styles.resolvedRequestContainer}
                 data-testid={testId || "resolved-request-wrapper"}>
                <TextContainer
                    className={styles.requestWrapper}
                    content={conversationBlock.prompt}
                    title={<UserBrandName name={displayName}
                                          picture={displayPicture} as="span"/>}
                    showCopyButton={true}
                    data-testid={testId || "resolved-request-wrapper"}
                />
                {conversationBlock.isLoading && (
                    <div className={styles.buttonWrapper}
                         data-testid="generate-button-wrapper"
                         style={{ marginTop: '1rem' }}>
                        <MultiPurposeButton
                            onClick={() => stopGenerating(blockId)}
                            label="Stop Generating"
                            disabled={false}
                            data-testid="generate-button"
                        />
                    </div>
                )}
            </div>
        )
    }

    // Otherwise show the editor
    return (

        <div className={styles.container}
             data-testid={testId || "request-widget-container"}>
            <PromptEditor
                id={blockId}
                value={draftPrompt}
                onChange={handleEditorChange}
                height="100%"
                className={styles.promptEditorFullscreen}
                data-testid="prompt-editor"
            />

            <div className={styles.buttonWrapper}
                 data-testid="generate-button-wrapper">
                <Tooltip content={!hasAnyValidApiKey ? "No API keys set" : ""}>
                    <div
                        style={!hasAnyValidApiKey ? {cursor: 'not-allowed'} : {}}>
                        <MultiPurposeButton
                            onClick={() => {
                                if (!hasAnyValidApiKey) return
                                const selectedId = getSelectedResponseForBlock(blockId)
                                generateResponsesStream(blockId, draftPrompt, selectedId)
                            }}
                            label="Generate"
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
