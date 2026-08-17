import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ICONS } from '../../../constants/icons'
import { TextEditor } from '@genflowly/component-library'
import { PillButton } from '@genflowly/component-library'
import { Tooltip } from '@genflowly/component-library'
import { Icon } from '@genflowly/component-library'
import { InputTextWithHint } from '@genflowly/component-library'
import { InputSelectWithHint } from '@genflowly/component-library'
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
    const { t } = useTranslation()
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
    const handleCreateInstruction = () => {
        if (!systemPrompt.trim()) return

        // Immediately collapse and clear editing state to allow user to continue
        setInstructionWidgetExpanded(false)
        setIsEditingName(false)

        // Fire and forget: handle the API call and state updates in the background
        ;(async () => {
             // Optimistic update: add a placeholder with a "pending" ID so it appears in dropdown immediately
             // If creating new, we use a constant ID to track the pending state.
             const isNew = !selectedInstructionId;
             const tempId = selectedInstructionId || 'pending-instruction-id';

             updateInstruction({
                 id: tempId,
                 name: '', // Empty name triggers the fallback to instruction text in dropdown
                 version: selectedInstructionId ? 0 : 1, // temporary version tracking
                 instruction: systemPrompt
             })
             
             if (isNew) {
                setSelectedInstructionId('pending-instruction-id');
             }

            try {
                // We still need the token as it's required for the background call
                const token = await getAccessTokenSilently()
                const response: InstructionResponse = await createInstruction(token, {
                    instruction: systemPrompt,
                    instructionName: instructionName || undefined,
                    existingInstructionId: selectedInstructionId || undefined
                })

                if (response.id) {
                    setSelectedInstructionId(response.id)
                    // Update the global state with the resolved data (ID, name/persona, version)
                    updateInstruction({
                        id: response.id,
                        name: response.name,
                        version: response.version,
                        instruction: systemPrompt
                    })
                }
                // Refresh list to ensure we are in sync with the backend
                // This also naturally clears any 'pending-instruction-id' entries since they aren't on server
                refreshInstructions()
            } catch (error) {
                console.error("Failed to save instruction in background", error)
                // Error handling is kept to console for now as widget is already closed
            }
        })()
    }

    if (!isInstructionWidgetExpanded) {
        return (
            <div className={styles.collapsedContainer}
                ref={containerRef}
                style={{ position: 'sticky', top: 0, zIndex: 2 }}
                data-testid={testId || "instruction-widget-collapsed"}>
                <div className={styles.instructionsCTAWrapper}
                    data-testid="instructions-cta-wrapper">
                    <div className={styles.spacer} />
                    <div style={{
                        flex: 1,
                    }}>
                        <InputSelectWithHint
                            hint={t('instructionWidget.instructionWidget.personaHint')}
                            icon={ICONS.USER_ROLE}
                            iconOnlyHintOnMobile
                            placeholder={t('instructionWidget.instructionWidget.selectPersonaPlaceholder')}
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
                                    label: item.name || (item.instruction.length > 50 ? `${item.instruction.substring(0, 50)}...` : item.instruction),
                                    value: item.id,
                                }));

                                const ctaOption = {
                                    label: t('instructionWidget.instructionWidget.createInstructionsCta'),
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
                        aria-label={t('instructionWidget.instructionWidget.editInstructionAriaLabel')}
                        title={t('instructionWidget.instructionWidget.editSelectedInstructionTitle')}
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
                        label: item.name || (item.instruction.length > 50 ? `${item.instruction.substring(0, 50)}...` : item.instruction),
                        value: item.id,
                    }));

                    const ctaOption = {
                        label: t('instructionWidget.instructionWidget.createInstructionsCta'),
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
                    // Match TextEditor structure:
                    <div className={styles.instructionContainer}>
                        <div className={styles.instructionContent}>
                            {/* Left Spacer */}
                            <div className={styles.spacer} />

                            {/* Main Content Area */}
                            <div className={styles.metadataVerticalGroup}>

                                {/* Row 1: Dropdown Selector */}
                                <div style={{ width: '100%' }}>
                                    <InputSelectWithHint
                                        hint={t('instructionWidget.instructionWidget.personaHint')}
                                        icon={ICONS.USER_ROLE}
                                        iconOnlyHintOnMobile
                                        placeholder={t('instructionWidget.instructionWidget.selectPersonaPlaceholder')}
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
                                                    hint={t('instructionWidget.instructionWidget.nameHint')}
                                                    value={instructionName}
                                                    onChange={(e) => setInstructionName(e.target.value)}
                                                    placeholder={t('instructionWidget.instructionWidget.instructionNamePlaceholder')}
                                                    className={styles.nameInput}
                                                    autoFocus
                                                    data-testid="instruction-name-input"
                                                />
                                                <button
                                                    onClick={() => setIsEditingName(false)}
                                                    className={styles.cancelButton}>
                                                    {t('instructionWidget.instructionWidget.cancel')}
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
                                                    {instructionName || latest?.name || t('instructionWidget.instructionWidget.untitledInstruction')}
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
                                                    title={t('instructionWidget.instructionWidget.renameInstructionTitle')}
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
                                                hint={t('instructionWidget.instructionWidget.versionHint')}
                                                icon={ICONS.HISTORY}
                                                iconOnlyHintOnMobile
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

            <TextEditor
                id="instruction-input"
                value={systemPrompt}
                onChange={setSystemPrompt}
                disableCache={true}
                height="100%"
                className={styles.textEditorFullscreen}
                data-testid="system-text-editor"
            />

            {/* Button Row - Aligning with Editor Box */}
            <div className={styles.buttonCommandRow}>
                <div className={styles.instructionContent}>
                    {/* Left Spacer */}
                    <div className={styles.spacer} />

                    {/* Main Content Area */}
                    <div className={styles.buttonContent}>
                        <PillButton
                            label={t('instructionWidget.instructionWidget.looksGood')}
                            variant="secondary"
                            onClick={() => setInstructionWidgetExpanded(false)}
                            data-testid="instruction-looks-good-button"
                        />

                        <Tooltip
                            content={!hasAnyValidApiKey ? t('instructionWidget.instructionWidget.noApiKeysSet') : ""}>
                            <div
                                style={!hasAnyValidApiKey ? { cursor: 'not-allowed' } : {}}>
                                <PillButton
                                    onClick={handleCreateInstruction}
                                    label={isLoading ? t('instructionWidget.instructionWidget.processing') : t('instructionWidget.instructionWidget.saveInstructions')}
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
