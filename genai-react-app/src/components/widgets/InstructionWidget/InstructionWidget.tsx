import React, { useState, useEffect, useRef } from 'react'
import { ICONS } from '../../../constants/icons'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import PillButton from '../../common/PillButton/PillButton'
import Tooltip from '../../common/Tooltip/Tooltip'
import { Icon } from '../../common/Icon/Icon'
import {
    InputTextWithHint
} from '../../common/InputTextWithHint/InputTextWithHint'
import {
    InputSelectWithHint
} from '../../common/InputSelectWithHint/InputSelectWithHint'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import styles from './InstructionWidget.module.scss'

import { useAuth0 } from '@auth0/auth0-react'
import {
    createInstruction,
    getInstructionVersion
} from '../../../services/instructionService'
import { InstructionResponse } from '../../../models/instruction.models'

export default function InstructionWidget({ 'data-testid': testId }: {
    'data-testid'?: string
}) {
    const {
        systemPrompt,
        setSystemPrompt,
        selectedInstructionId,
        setSelectedInstructionId,
    } = useAI()

    const { getAccessTokenSilently } = useAuth0()
    // Use LayoutContext for expansion state
    const {
        isInstructionWidgetExpanded,
        setInstructionWidgetExpanded
    } = useLayout()

    const {
        aiVendorAPIKeyStatusList,
        refreshInstructions,
        updateInstruction,
        customerInstructions
    } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const [isLoading, setIsLoading] = useState(false)
    const [instructionName, setInstructionName] = useState('')
    const [isEditingName, setIsEditingName] = useState(false)
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)

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
            <div className={styles.collapsedContainer}
                ref={containerRef}
                data-testid={testId || "instruction-widget-collapsed"}>
                <div className={styles.instructionsCTAWrapper}
                    data-testid="instructions-cta-wrapper">
                    <div style={{
                        flex: 1,
                    }}>
                        <InputSelectWithHint
                            hint="Instructions"
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
                                    label: '[+] Create Instructions',
                                    value: 'CTA_ACTION',
                                    isCta: true,
                                    ctaAction: () => {
                                        setSelectedInstructionId(null)
                                        setSystemPrompt('')
                                        setInstructionWidgetExpanded(true)
                                        setTimeout(() => {
                                            containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                        }, 100)
                                    },
                                    style: {
                                        borderTop: '1px solid #e5e7eb',
                                        marginTop: '4px',
                                        paddingTop: '8px',
                                        color: '#2563eb',
                                        fontWeight: 500
                                    }
                                }
                                const separatorOption = {
                                    label: '────────────────',
                                    value: 'SEPARATOR',
                                    disabled: true
                                }
                                return [...filteredOptions, separatorOption, ctaOption]
                            })()}
                            data-testid="instruction-selector-collapsed"
                        />
                    </div>
                    <button
                        className={styles.editButton}
                        onClick={() => setInstructionWidgetExpanded(true)}
                        aria-label="Edit instruction"
                        title="Edit selected instruction"
                        data-testid="instruction-edit-button"
                    >
                        <Icon src={ICONS.EDIT} className={styles.editIcon} />
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className={styles.container}
            ref={containerRef}
            data-testid={testId || "instruction-widget-expanded"}>
            {/* Metadata Display / Edit */}
            {(() => {
                // Config for options
                const instructionOptions = (() => {
                    const filteredOptions = uniqueInstructions.map(item => ({
                        label: item.name || item.instruction.substring(0, 50),
                        value: item.id,
                    }));

                    const ctaOption = {
                        label: '[+] Create Instructions',
                        value: 'CTA_ACTION',
                        isCta: true,
                        ctaAction: () => {
                            setSelectedInstructionId(null)
                            setSystemPrompt('')
                            // Ensure widget stays expanded
                            setInstructionWidgetExpanded(true)
                            setTimeout(() => {
                                containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            }, 100)
                        },
                        style: {
                            borderTop: '1px solid #e5e7eb',
                            marginTop: '4px',
                            paddingTop: '8px',
                            color: '#2563eb',
                            fontWeight: 500
                        }
                    }
                    const separatorOption = {
                        label: '────────────────',
                        value: 'SEPARATOR',
                        disabled: true
                    }
                    return [...filteredOptions, separatorOption, ctaOption]
                })()

                // Find latest version of this instruction to establish baseline
                const latest = selectedInstructionId ? customerInstructions.find(i => i.id === selectedInstructionId) : null
                const latestVersion = latest ? latest.version : 1

                return (
                    // Match PromptEditor structure:
                    <div className={styles.instructionContainer}>
                        <div className={styles.instructionContent}>
                            {/* Left Spacer */}
                            <div className={styles.spacer} />

                            {/* Main Content Area */}
                            <div className={styles.metadataVerticalGroup}>

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
                                        data-testid="instruction-selector"
                                    />
                                </div>

                                {/* Row 2: Name and Version */}
                                <div className={styles.metadataRow}>

                                    {/* Left: Name (or Edit Input) */}
                                    <div style={{
                                        flex: 1,
                                        marginRight: '1rem',
                                        minWidth: 0,
                                        display: 'flex',
                                        alignItems: 'center'
                                    }}>
                                        {isEditingName ? (
                                            <div className={styles.titleGroup}
                                                style={{ width: '100%' }}>
                                                <InputTextWithHint
                                                    hint="Name"
                                                    value={instructionName}
                                                    onChange={(e) => setInstructionName(e.target.value)}
                                                    placeholder="Instruction Name"
                                                    className={styles.nameInput}
                                                    autoFocus
                                                    data-testid="instruction-name-input"
                                                />
                                                <button
                                                    onClick={() => setIsEditingName(false)}
                                                    className={styles.cancelButton}>
                                                    Cancel
                                                </button>
                                            </div>
                                        ) : (
                                            <div className={styles.titleGroup}>
                                                <span
                                                    className={styles.instructionName}
                                                    style={{
                                                        fontSize: '1.2rem',
                                                        marginRight: '0.5rem'
                                                    }}
                                                    data-testid="instruction-name-display">
                                                    {instructionName || latest?.name || 'Untitled Instruction'}
                                                </span>
                                                <button
                                                    onClick={() => {
                                                        setInstructionName(instructionName || (latest?.name || ''))
                                                        setIsEditingName(true)
                                                    }}
                                                    style={{
                                                        background: 'none',
                                                        border: 'none',
                                                        cursor: 'pointer',
                                                        padding: '0.5rem',
                                                        display: 'flex',
                                                        alignItems: 'center'
                                                    }}
                                                    title="Rename Instruction"
                                                >
                                                    <Icon src={ICONS.EDIT}
                                                        size={16}
                                                        className={styles.editIcon} />
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
                            <div className={styles.spacer} />
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
                data-testid="system-prompt-editor"
            />

            {/* Button Row - Aligning with Editor Box */}
            <div className={styles.buttonCommandRow}>
                <div className={styles.instructionContent}>
                    {/* Left Spacer */}
                    <div className={styles.spacer} />

                    {/* Main Content Area */}
                    <div className={styles.buttonContent}>
                        <PillButton
                            label="Looks good"
                            variant="secondary"
                            onClick={() => setInstructionWidgetExpanded(false)}
                            data-testid="instruction-looks-good-button"
                        />

                        <Tooltip
                            content={!hasAnyValidApiKey ? "No API keys set" : ""}>
                            <div
                                style={!hasAnyValidApiKey ? { cursor: 'not-allowed' } : {}}>
                                <PillButton
                                    onClick={handleCreateInstruction}
                                    label={isLoading ? 'Processing...' : 'Save Instructions'}
                                    disabled={isLoading || !systemPrompt.trim()}
                                    icon={ICONS.SAVE_ICON}
                                    variant="primary"
                                    data-testid="save-instruction-button"
                                />
                            </div>
                        </Tooltip>
                    </div>

                    {/* Right Spacer */}
                    <div className={styles.spacer} />
                </div>
            </div>
        </div>
    )
}
