import React, { useState, useEffect } from 'react'
import { ICONS } from '../../../constants/icons'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import PillButton from '../../common/PillButton/PillButton'
import Tooltip from '../../common/Tooltip/Tooltip'
import { Icon } from '../../common/Icon/Icon'
import { InputTextWithHint } from '../../common/InputTextWithHint/InputTextWithHint'
import { InputSelectWithHint } from '../../common/InputSelectWithHint/InputSelectWithHint'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import styles from './InstructionWidget.module.scss'

import { useAuth0 } from '@auth0/auth0-react'
import { createInstruction, getInstructionVersion } from '../../../services/instructionService'
import { InstructionResponse } from '../../../models/instruction.models'

export default function InstructionWidget() {
    const {
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
    } = useAI()

    const { getAccessTokenSilently } = useAuth0()
    // Use LayoutContext for expansion state
    const { isInstructionWidgetExpanded, setInstructionWidgetExpanded } = useLayout()

    const { aiVendorAPIKeyStatusList, refreshInstructions, updateInstruction, customerInstructions } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const [isLoading, setIsLoading] = useState(false)
    const [instructionName, setInstructionName] = useState('')
    const [isEditingName, setIsEditingName] = useState(false)
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null)

    // Reset/Init version when ID changes (default to latest)
    useEffect(() => {
        if (selectedInstructionId) {
            const matching = customerInstructions.filter(i => i.id === selectedInstructionId)
            const latest = matching.sort((a, b) => b.version - a.version)[0]
            if (latest) {
                setSelectedVersion(latest.version)
            }
        } else {
            setSelectedVersion(null)
        }
    }, [selectedInstructionId, customerInstructions])

    // Sync content when ID OR Version changes
    useEffect(() => {
        if (selectedInstructionId && selectedVersion !== null) {
            const matching = customerInstructions.find(i => i.id === selectedInstructionId)

            if (matching && matching.version === selectedVersion) {
                setSystemPrompt(matching.instruction)
                setInstructionName(matching.name)
            }
        } else if (!selectedInstructionId) {
            // Fallback for new creation or empty state
            // If no instruction selected, we just keep the current systemPrompt or clear it?
            // Usually we keep what's there if it was being edited, but the original logic
            // reset it to `systemPrompt` (itself).
            // Let's just ensure name is cleared.
            setInstructionName('')
        }
    }, [selectedInstructionId, customerInstructions, selectedVersion, setSystemPrompt])

    // ... (existing handlers)
    const handleCreateInstruction = async () => {
        if (!systemPrompt.trim()) return

        setIsLoading(true)
        try {
            const token = await getAccessTokenSilently()
            const response: InstructionResponse = await createInstruction(token, {
                instruction: systemPrompt,
                instructionName: instructionName || undefined,
                existingInstructionId: selectedInstructionId || undefined
            })

            setSystemPrompt(systemPrompt)
            // Update the selected ID immediately so UI reflects it's an existing instruction now
            if (response.id) {
                setSelectedInstructionId(response.id)
                // Optimistic update
                updateInstruction({
                    id: response.id,
                    name: response.name,
                    version: response.version,
                    instruction: systemPrompt
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
                // Find latest version of this instruction to establish baseline
                const latest = customerInstructions.find(i => i.id === selectedInstructionId)

                if (!latest) return null

                // Determine max version from the latest record
                const latestVersion = latest.version

                return (
                    // Match PromptEditor structure:
                    // 1. Outer Container Padding (0 3rem)
                    // 2. Inner Container Max Width (88rem) + Gap (1rem)
                    // 3. Spacers (2rem)
                    <div style={{ width: '100%', padding: '0 3rem', display: 'flex', justifyContent: 'center' }}>
                        <div style={{ width: '100%', maxWidth: '88rem', display: 'flex', gap: '1rem' }}>
                            {/* Left Spacer to match Editor Spacer */}
                            <div style={{ width: '2rem', flexShrink: 0 }} />

                            {/* Main Content Area - Aligning with Editor Box */}
                            <div className={styles.metadataContainer} style={{ flex: 1, marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {isEditingName ? (
                                    <div className={styles.titleGroup}>
                                        <InputTextWithHint
                                            hint="Name"
                                            value={instructionName}
                                            onChange={(e) => setInstructionName(e.target.value)}
                                            placeholder="Instruction Name"
                                            className={styles.nameInput}
                                        />
                                        <button onClick={() => setIsEditingName(false)} className={styles.cancelButton}>
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <div className={styles.metadataHeader}>
                                        <div className={styles.titleGroup}>
                                            <span className={styles.instructionName}>{instructionName || latest.name}</span>
                                            <button
                                                onClick={() => {
                                                    setInstructionName(instructionName || latest.name)
                                                    setIsEditingName(true)
                                                }}
                                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
                                            >
                                                <Icon src={ICONS.EDIT} size={14} className={styles.editIcon} />
                                            </button>
                                        </div>
                                        <div style={{ width: '140px' }}>
                                            <InputSelectWithHint
                                                hint="Version"
                                                value={selectedVersion?.toString() || ''}
                                                onChange={async (val) => {
                                                    const newVersion = parseInt(val, 10)
                                                    if (!isNaN(newVersion)) {
                                                        setSelectedVersion(newVersion)
                                                        setIsLoading(true)
                                                        try {
                                                            const token = await getAccessTokenSilently()
                                                            const data = await getInstructionVersion(token, selectedInstructionId, newVersion)
                                                            setSystemPrompt(data.instruction || '')
                                                            setInstructionName(data.name || '')
                                                        } catch (e) {
                                                            console.error("Failed to fetch version", e)
                                                        } finally {
                                                            setIsLoading(false)
                                                        }
                                                    }
                                                }}
                                                options={(() => {
                                                    // Generate options 1..latestVersion
                                                    // ensure we at least have 1
                                                    const maxVer = Math.max(latestVersion, 1)
                                                    const opts = []
                                                    for (let i = maxVer; i >= 1; i--) {
                                                        opts.push({
                                                            label: i.toString(),
                                                            value: i.toString()
                                                        })
                                                    }
                                                    return opts
                                                })()}
                                                className={styles.versionSelect}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Right Spacer to match Editor ControlsRow */}
                            <div style={{ width: '2rem', flexShrink: 0 }} />
                        </div>
                    </div>
                )
            })()}

            <PromptEditor
                id="instruction-input"
                value={systemPrompt}
                onChange={setSystemPrompt}
                disableCache={true}
            />

            {/* Button Row - Aligning with Editor Box */}
            <div style={{ width: '100%', padding: '0 3rem', display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
                <div style={{ width: '100%', maxWidth: '88rem', display: 'flex', gap: '1rem' }}>
                    {/* Left Spacer */}
                    <div style={{ width: '2rem', flexShrink: 0 }} />

                    {/* Main Content Area */}
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <PillButton
                            label="Looks good"
                            variant="secondary"
                            onClick={() => setInstructionWidgetExpanded(false)}
                        />

                        <Tooltip content={!hasAnyValidApiKey ? "No API keys set" : ""}>
                            <div style={!hasAnyValidApiKey ? { cursor: 'not-allowed' } : {}}>
                                <PillButton
                                    onClick={handleCreateInstruction}
                                    label={isLoading ? 'Processing...' : 'Save Instructions'}
                                    disabled={isLoading || !systemPrompt.trim()}
                                    icon={ICONS.SAVE_ICON}
                                    variant="primary"
                                />
                            </div>
                        </Tooltip>
                    </div>

                    {/* Right Spacer */}
                    <div style={{ width: '2rem', flexShrink: 0 }} />
                </div>
            </div>
        </div>
    )
}
