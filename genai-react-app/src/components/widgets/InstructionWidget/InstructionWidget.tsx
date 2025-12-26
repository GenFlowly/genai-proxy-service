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

import { useAuth0 } from '@auth0/auth0-react'
import { createInstruction } from '../../../services/instructionService'
import { CreateInstructionResponse } from '../../../models/instruction.models'

export default function InstructionWidget() {
    const {
        systemPrompt,
        setSystemPrompt,
    } = useConversation()

    const { getAccessTokenSilently } = useAuth0()
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

    const handleCreateInstruction = async () => {
        if (!prompt.trim()) return

        setIsLoading(true)
        try {
            const token = await getAccessTokenSilently()
            const response: CreateInstructionResponse = await createInstruction(token, {
                instruction: prompt
            })

            setSystemPrompt(prompt)
            setInstructionWidgetExpanded(false) // Collapse after generation
        } catch (error) {
            console.error("Failed to save instruction", error)
            // Optionally add user notify here
        } finally {
            setIsLoading(false)
        }
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
                        onClick={handleCreateInstruction}
                        label={isLoading ? 'Processing...' : 'Save' +
                            ' Instructions'}
                        disabled={isLoading || !prompt.trim()}
                        icon={ICONS.SAVE_ICON}
                    />
                </div>
            </Tooltip>
        </div>
    )
}
