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
            setInstructionName('')
        }
    }, [selectedInstructionId, customerInstructions, selectedVersion, setSystemPrompt])

    // Filter instructions to show only the latest version for each ID
    const uniqueInstructions = React.useMemo(() => {
        if (!customerInstructions) return []
        const map = new Map<string, typeof customerInstructions[0]>()
        customerInstructions.forEach(inst => {
            const existing = map.get(inst.id)
            if (!existing || inst.version > existing.version) {
                map.set(inst.id, inst)
            }
        })
        return Array.from(map.values())
    }, [customerInstructions])

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
                <div style={{ flex: 1, maxWidth: '70rem', paddingRight: '0.5rem' }}>
                    <InputSelectWithHint
                        hint="Instructions for AI"
                        icon={ICONS.USER_ROLE}
                        placeholder="Select a persona"
                        className={styles.roleInput}
                        value={(() => {
                            if (selectedInstructionId) return selectedInstructionId
                            return (isInstructionWidgetExpanded) ? 'CTA_ACTION' : ''
                        })()}
                        onChange={(val) => {
                            const selectedInstruction = uniqueInstructions.find(i => i.id === val)
                            if (selectedInstruction) {
                                setSelectedInstructionId(selectedInstruction.id)
                                setSystemPrompt(selectedInstruction.instruction)
                            } else {
                                setSelectedInstructionId(null)
                                // Only clear system prompt if explicitly deselecting?
                                // setSystemPrompt('') // Maybe?
                            }
                        }}
                        options={(() => {
                            const filteredOptions = uniqueInstructions.map(item => ({
                                label: item.name || item.instruction.substring(0, 50),
                                value: item.id,
                            }));

                            const ctaOption = {
                                label: 'Create Instructions',
                                value: 'CTA_ACTION',
                                isCta: true,
                                ctaAction: () => {
                                    setSelectedInstructionId(null)
                                    setSystemPrompt('')
                                    setInstructionWidgetExpanded(true)
                                },
                                style: {
                                    borderTop: '1px solid #e5e7eb',
                                    marginTop: '4px',
                                    paddingTop: '8px',
                                    color: '#2563eb',
                                    fontWeight: 500
                                }
                            }
                            return [...filteredOptions, ctaOption]
                        })()}
                    />
                </div>
                <button
                    className={styles.editButton}
                    onClick={() => setInstructionWidgetExpanded(true)}
                    aria-label="Edit instruction"
                    title="Edit selected instruction"
                >
                    <Icon src={ICONS.EDIT} className={styles.editIcon} />
                </button>
            </div>
        )
    }

    return (
        <div className={styles.container}>
            {/* Metadata Display / Edit */}
            {(() => {
                // Config for options
                const instructionOptions = (() => {
                    const filteredOptions = uniqueInstructions.map(item => ({
                        label: item.name || item.instruction.substring(0, 50),
                        value: item.id,
                    }));

                    const ctaOption = {
                        label: 'Create Instructions',
                        value: 'CTA_ACTION',
                        isCta: true,
                        ctaAction: () => {
                            setSelectedInstructionId(null)
                            setSystemPrompt('')
                            // Ensure widget stays expanded
                            setInstructionWidgetExpanded(true)
                        },
                        style: {
                            borderTop: '1px solid #e5e7eb',
                            marginTop: '4px',
                            paddingTop: '8px',
                            color: '#2563eb',
                            fontWeight: 500
                        }
                    }
                    return [...filteredOptions, ctaOption]
                })()

                // Find latest version of this instruction to establish baseline
                const latest = selectedInstructionId ? customerInstructions.find(i => i.id === selectedInstructionId) : null
                const latestVersion = latest ? latest.version : 1

                return (
                    // Match PromptEditor structure:
                    <div style={{ width: '100%', padding: '0 3rem', display: 'flex', justifyContent: 'center' }}>
                        <div style={{ width: '100%', maxWidth: '75rem', display: 'flex', gap: '1rem' }}>
                            {/* Left Spacer */}
                            <div style={{ width: '2rem', flexShrink: 0 }} />

                            {/* Main Content Area */}
                            <div className={styles.metadataContainer} style={{ flex: 1, marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                                {/* Row 1: Dropdown Selector */}
                                <div style={{ width: '100%' }}>
                                    <InputSelectWithHint
                                        hint="Persona"
                                        icon={ICONS.USER_ROLE}
                                        placeholder="Select a persona"
                                        className={styles.roleInput}
                                        value={selectedInstructionId || ''}
                                        onChange={(val) => {
                                            const selectedInstruction = uniqueInstructions.find(i => i.id === val)
                                            if (selectedInstruction) {
                                                setSelectedInstructionId(selectedInstruction.id)
                                                setSystemPrompt(selectedInstruction.instruction)
                                            } else {
                                                setSelectedInstructionId(null)
                                            }
                                        }}
                                        options={instructionOptions}
                                    />
                                </div>

                                {/* Row 2: Name and Version */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>

                                    {/* Left: Name (or Edit Input) */}
                                    <div style={{ flex: 1, marginRight: '1rem', minWidth: 0, display: 'flex', alignItems: 'center' }}>
                                        {isEditingName ? (
                                            <div className={styles.titleGroup} style={{ width: '100%' }}>
                                                <InputTextWithHint
                                                    hint="Name"
                                                    value={instructionName}
                                                    onChange={(e) => setInstructionName(e.target.value)}
                                                    placeholder="Instruction Name"
                                                    className={styles.nameInput}
                                                    autoFocus
                                                />
                                                <button onClick={() => setIsEditingName(false)} className={styles.cancelButton}>
                                                    Cancel
                                                </button>
                                            </div>
                                        ) : (
                                            <div className={styles.titleGroup}>
                                                <span className={styles.instructionName} style={{ fontSize: '1.2rem', marginRight: '0.5rem' }}>
                                                    {instructionName || latest?.name || 'Untitled Instruction'}
                                                </span>
                                                <button
                                                    onClick={() => {
                                                        setInstructionName(instructionName || (latest?.name || ''))
                                                        setIsEditingName(true)
                                                    }}
                                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem', display: 'flex', alignItems: 'center' }}
                                                    title="Rename Instruction"
                                                >
                                                    <Icon src={ICONS.EDIT} size={16} className={styles.editIcon} />
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    {/* Right: Version Selector */}
                                    {latest && (
                                        <div style={{ flexShrink: 0 }}>
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
                                                            if (selectedInstructionId) {
                                                                const data = await getInstructionVersion(token, selectedInstructionId, newVersion)
                                                                setSystemPrompt(data.instruction || '')
                                                                setInstructionName(data.name || '')
                                                            }
                                                        } catch (e) {
                                                            console.error("Failed to fetch version", e)
                                                        } finally {
                                                            setIsLoading(false)
                                                        }
                                                    }
                                                }}
                                                options={(() => {
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
                                    )}
                                </div>
                            </div>

                            {/* Right Spacer */}
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
                height="100%"
                className={styles.promptEditorFullscreen}
            />

            {/* Button Row - Aligning with Editor Box */}
            <div style={{ width: '100%', padding: '0 3rem', display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
                <div style={{ width: '100%', maxWidth: '75rem', display: 'flex', gap: '1rem' }}>
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
