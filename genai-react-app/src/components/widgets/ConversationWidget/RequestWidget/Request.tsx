import React, { useEffect } from 'react'
import { ICONS } from '../../../../constants/icons'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../../common/Tooltip/Tooltip'
import { useConversation } from '../../../../context/ConversationContext'
import { useAuth } from '../../../../context/AuthContext'
import TextContainer from '../../../common/TextContainer/TextContainer'
import styles from './Request.module.scss'

interface RequestProps {
    blockId: string
}

export default function Request({ blockId }: RequestProps) {
    const {
        conversationBlockList,
        generateResponses,
        getSelectedResponseForBlock,
        setEditorPrompt,
        setActiveBlockId
    } = useConversation()

    const { aiVendorAPIKeyStatusList } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === blockId)

    // ✅ Local draft state to prevent global re-renders on typing
    const [draftPrompt, setDraftPrompt] = React.useState(conversationBlock?.prompt || '')

    // Dependencies moved from PromptEditor
    const { customerId } = useAuth()
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

    // If we have responses, this block is "resolved" -> Show static text
    if (conversationBlock.responseMessages.length > 0) {
        return (
            <div className={styles.requestWrapper}>
                <TextContainer
                    content={conversationBlock.prompt}
                    // No title or aiVendor, just the user prompt
                    showCopyButton={true}
                />
            </div>
        )
    }

    // Otherwise show the editor
    return (
        <>
            <PromptEditor
                id={blockId}
                value={draftPrompt}
                onChange={handleEditorChange}
            />

            <Tooltip content={!hasAnyValidApiKey ? "No API keys set" : ""}>
                <div style={!hasAnyValidApiKey ? { cursor: 'not-allowed' } : {}}>
                    <MultiPurposeButton
                        onClick={() => {
                            if (!hasAnyValidApiKey) return
                            const selectedId = getSelectedResponseForBlock(blockId)
                            generateResponses(blockId, draftPrompt, selectedId)
                        }}
                        label={conversationBlock.isLoading ? 'Generating...' : 'Generate'}
                        disabled={conversationBlock.isLoading || !hasAnyValidApiKey}
                        icon={ICONS.SEND}
                    />
                </div>
            </Tooltip>
        </>
    )
}
