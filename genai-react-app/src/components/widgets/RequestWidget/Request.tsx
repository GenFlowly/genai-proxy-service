import React, { useEffect } from 'react'
import { ICONS } from '../../../constants/icons'
import PromptEditor from '../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../common/Tooltip/Tooltip'
import { useConversation } from '../../../context/ConversationContext'
import { useAuth } from '../../../context/AuthContext'
import TextContainer from '../../common/TextContainer/TextContainer'

interface RequestProps {
    blockId: string
}

export default function Request({ blockId }: RequestProps) {
    const {
        conversationBlockList,
        generateResponses,
        getSelectedResponseForBlock
    } = useConversation()

    const { aiVendorAPIKeyStatusList } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === blockId)

    // ✅ Local draft state to prevent global re-renders on typing
    const [draftPrompt, setDraftPrompt] = React.useState(conversationBlock?.prompt || '')

    // Sync draft if global prompt changes (e.g. history load or API success)
    useEffect(() => {
        if (conversationBlock?.prompt && conversationBlock.prompt !== draftPrompt) {
            setDraftPrompt(conversationBlock.prompt)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationBlock?.prompt])

    if (!conversationBlock) return null

    // If we have responses, this block is "resolved" -> Show static text
    if (conversationBlock.responseMessages.length > 0) {
        return (
            <TextContainer
                content={conversationBlock.prompt}
                // No title or aiVendor, just the user prompt
                showCopyButton={true}
            />
        )
    }

    // Otherwise show the editor
    return (
        <>
            <PromptEditor
                id={blockId}
                value={draftPrompt}
                onChange={setDraftPrompt}
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
