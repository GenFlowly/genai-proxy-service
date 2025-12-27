import React, { useState, useEffect } from 'react'
import { ICONS } from '../../../constants/icons'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../common/Tooltip/Tooltip'
import { Icon } from '../../common/Icon/Icon'
import { InputTextWithHint } from '../../common/InputTextWithHint/InputTextWithHint'
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
        selectedInstructionId,
        setSelectedInstructionId,
    } = useConversation()

    const { getAccessTokenSilently } = useAuth0()
    // Use LayoutContext for expansion state
    const { isInstructionWidgetExpanded, setInstructionWidgetExpanded } = useLayout()

    const { aiVendorAPIKeyStatusList, refreshInstructions, updateInstruction, customerInstructions } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const [prompt, setPrompt] = useState(systemPrompt)
    const [isLoading, setIsLoading] = useState(false)
    const [instructionName, setInstructionName] = useState('')
    const [isEditingName, setIsEditingName] = useState(false)

    // Sync local prompt and name with global system when expanded or changed
    useEffect(() => {
        setPrompt(systemPrompt)
        if (selectedInstructionId) {
            // Find latest version of current selection to populate name
            const matching = customerInstructions.filter(i => i.id === selectedInstructionId)
            const latest = matching.sort((a, b) => b.version - a.version)[0]
            if (latest) {
                setInstructionName(latest.name)
            }
        } else {
            setInstructionName('')
        }
    }, [systemPrompt, selectedInstructionId, customerInstructions])

    const handleCreateInstruction = async () => {
        if (!prompt.trim()) return

        setIsLoading(true)
        try {
            const token = await getAccessTokenSilently()
            const response: CreateInstructionResponse = await createInstruction(token, {
                instruction: prompt,
                instructionName: instructionName || undefined,
                existingInstructionId: selectedInstructionId || undefined
            })

            setSystemPrompt(prompt)
            // Update the selected ID immediately so UI reflects it's an existing instruction now
            if (response.id) {
                setSelectedInstructionId(response.id)
                // Optimistic update
                updateInstruction({
                    id: response.id,
                    name: response.name,
                    version: response.version,
                    instruction: prompt
                })
            }
            // Still refresh in background to be safe
            refreshInstructions()
            setInstructionWidgetExpanded(false) // Collapse after generation
            setIsEditingName(false)
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
            {/* Metadata Display / Edit */}
            {selectedInstructionId && (() => {
                // Find all versions of this instruction
                const versions = customerInstructions.filter(i => i.id === selectedInstructionId)
                // Sort by version desc and take first (latest)
                const selected = versions.sort((a, b) => b.version - a.version)[0]

                if (!selected) return null

                return (
                    <div className={styles.metadataContainer} style={{ marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {isEditingName ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <InputTextWithHint
                                    hint="Name"
                                    value={instructionName}
                                    onChange={(e) => setInstructionName(e.target.value)}
                                    placeholder="Instruction Name"
                                    className={styles.nameInput}
                                />
                                <button onClick={() => setIsEditingName(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', fontSize: '12px' }}>
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <div style={{ fontSize: '14px', color: '#333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontWeight: 600 }}>{selected.name}</span>
                                    <button
                                        onClick={() => {
                                            setInstructionName(selected.name)
                                            setIsEditingName(true)
                                        }}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
                                    >
                                        <Icon src={ICONS.EDIT} size={14} className={styles.editIcon} />
                                    </button>
                                </div>
                                <span style={{ fontSize: '12px', color: '#666' }}>v{selected.version}</span>
                            </div>
                        )}
                    </div>
                )
            })()}

            <PromptEditor
                id="instruction-input"
                value={prompt}
                onChange={setPrompt}
                disableCache={true}
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
