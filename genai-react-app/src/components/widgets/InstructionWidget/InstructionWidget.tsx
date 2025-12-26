import React, { useState, useEffect } from 'react'
import { ICONS } from '../../../constants/icons'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../common/Tooltip/Tooltip'
import { Icon } from '../../common/Icon/Icon'
import { useConversation } from '../../../context/ConversationContext'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import styles from './InstructionWidget.module.scss'

export default function InstructionWidget() {
    const {
        systemPrompt,
        setSystemPrompt,
        addNewConversationBlockWithId,
        updateResponseInConversationBlock,
        generateResponses
    } = useConversation()

    // Use LayoutContext for expansion state
    const { isInstructionWidgetExpanded, setInstructionWidgetExpanded } = useLayout()

    const { aiVendorAPIKeyStatusList } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const [prompt, setPrompt] = useState(systemPrompt)
    const [isLoading, setIsLoading] = useState(false)

    // Sync local prompt with global system prompt when expanded or changed externally
    useEffect(() => {
        setPrompt(systemPrompt)
    }, [systemPrompt])

    const handleGenerate = async () => {
        if (!prompt.trim() || !hasAnyValidApiKey) return

        setIsLoading(true)
        setSystemPrompt(prompt)

        const newBlockId = `conv-${Date.now()}`
        addNewConversationBlockWithId(newBlockId)
        updateResponseInConversationBlock(newBlockId, prompt)

        await generateResponses(newBlockId, prompt)

        setIsLoading(false)
        setInstructionWidgetExpanded(false) // Collapse after generation
    }

    if (!isInstructionWidgetExpanded) {
        return (
            <div className={styles.collapsedContainer}>
                <button
                    className={styles.editButton}
                    onClick={() => setInstructionWidgetExpanded(true)}
                    aria-label="Edit instruction"
                >
                    <span className={styles.collapsedText}>Edit instruction</span>
                    <Icon src={ICONS.EDIT} className={styles.editIcon} />
                </button>
            </div>
        )
    }

    return (
        <div className={styles.container}>
            <PromptEditor
                id="instruction-input"
                value={prompt}
                onChange={setPrompt}
            />

            <Tooltip content={!hasAnyValidApiKey ? "No API keys set" : ""}>
                <div style={!hasAnyValidApiKey ? { cursor: 'not-allowed' } : {}}>
                    <MultiPurposeButton
                        onClick={handleGenerate}
                        label={isLoading ? 'Processing...' : 'Save' +
                            ' Instructions'}
                        disabled={isLoading || !hasAnyValidApiKey || !prompt.trim()}
                        icon={ICONS.SAVE_ICON}
                    />
                </div>
            </Tooltip>
        </div>
    )
}
