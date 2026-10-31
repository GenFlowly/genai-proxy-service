import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { InstructionResponse } from '../models/instruction.models'
import { useAuth } from './AuthContext'
import { customerKey, StorageSuffix } from '../utils/storageKeys'

export interface AIConfig {
    /** Vendor id: legacy enum name (OPENAI/CLAUDE/GEMINI) or a BYOK provider id */
    aiVendor: string
    model: string
    /**
     * Reasoning effort for this vendor's responses ('' /undefined = vendor
     * default, else none|low|medium|high). Rides the generate request's
     * aiConfig, where it overrides the agent's node-level thinking_level.
     */
    thinkingLevel?: string
}

interface AIContextType {
    config: AIConfig[]
    setSelectedModelForAIVendor: (aiVendor: string, model: string) => void
    setThinkingLevelForAIVendor: (aiVendor: string, thinkingLevel: string) => void
    resetConfig: () => void
    activeBlockId: string
    setActiveBlockId: (id: string) => void
    supplementalText: string
    setSupplementalText: (text: string) => void
    customerInstructions: InstructionResponse[]
    systemPrompt: string
    setSystemPrompt: (prompt: string) => void
    selectedInstructionId: string | null
    setSelectedInstructionId: (id: string | null) => void
    isSystemPromptLoaded: boolean
    /**
     * Agent (graph) the user made their default via the picker; null = never
     * picked (falls back to their own default graph, then the System one).
     */
    selectedAgentId: string | null
    setSelectedAgentId: (id: string | null) => void
}

const AIContext = createContext<AIContextType | undefined>(undefined)

export const AIProvider = ({ children }: { children: ReactNode }) => {
    const [config, setConfig] = useState<AIConfig[]>([])
    const [activeBlockId, setActiveBlockId] = useState<string>('')
    const [supplementalText, setSupplementalText] = useState<string>('')
    const { customerInstructions, customerId, aiConfigPreferences, aiVendorAPIKeyStatusList } = useAuth()
    const [systemPrompt, setSystemPrompt] = useState<string>('')
    const [selectedInstructionId, setSelectedInstructionId] = useState<string | null>(null)
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
    const [agentPrefSeeded, setAgentPrefSeeded] = useState(false)
    const [isSystemPromptLoaded, setIsSystemPromptLoaded] = useState<boolean>(false)
    const [loadedPreferencesSignature, setLoadedPreferencesSignature] = useState<string>('')

    // 🔹 Restore from localStorage
    useEffect(() => {
        if (customerId) {
            const savedPrompt = localStorage.getItem(customerKey(customerId, StorageSuffix.systemPrompt))
            const savedInstructionId = localStorage.getItem(customerKey(customerId, StorageSuffix.selectedInstructionId))
            const savedAgentId = localStorage.getItem(customerKey(customerId, StorageSuffix.selectedAgentId))

            setSystemPrompt(savedPrompt || '')
            setSelectedInstructionId(savedInstructionId || null)
            setSelectedAgentId(savedAgentId || null)
            setIsSystemPromptLoaded(true)
        } else {
            setIsSystemPromptLoaded(false)
        }
    }, [customerId])

    // 🔹 Persist to localStorage
    useEffect(() => {
        if (customerId && isSystemPromptLoaded) {
            const promptKey = customerKey(customerId, StorageSuffix.systemPrompt)
            const idKey = customerKey(customerId, StorageSuffix.selectedInstructionId)

            if (systemPrompt.trim()) {
                localStorage.setItem(promptKey, systemPrompt)
            } else {
                localStorage.removeItem(promptKey)
            }

            if (selectedInstructionId) {
                localStorage.setItem(idKey, selectedInstructionId)
            } else {
                localStorage.removeItem(idKey)
            }

            const agentKey = customerKey(customerId, StorageSuffix.selectedAgentId)
            if (selectedAgentId) {
                localStorage.setItem(agentKey, selectedAgentId)
            } else {
                localStorage.removeItem(agentKey)
            }
        }
    }, [systemPrompt, selectedInstructionId, selectedAgentId, customerId, isSystemPromptLoaded])

    // 🔹 Seed the agent selection from the account preference once per login.
    // localStorage (this device's last explicit pick) wins over the backend
    // value; later picks are pushed to the backend by the AgentPicker widget.
    useEffect(() => {
        if (!customerId || !isSystemPromptLoaded || agentPrefSeeded || !aiConfigPreferences) return
        const saved = localStorage.getItem(customerKey(customerId, StorageSuffix.selectedAgentId))
        if (!saved && aiConfigPreferences.preferredAgentId) {
            setSelectedAgentId(aiConfigPreferences.preferredAgentId)
        }
        setAgentPrefSeeded(true)
    }, [customerId, isSystemPromptLoaded, aiConfigPreferences, agentPrefSeeded])

    // 🔹 Sync backend model preferences into config as soon as they load.
    // This must live here (not in AIVendorWidget): the widget only mounts when
    // the AI settings sidebar/modal is open, so on mobile the config stayed
    // empty until the user opened it.
    useEffect(() => {
        if (!aiConfigPreferences?.preferredModels) return

        const currentSignature = JSON.stringify(aiConfigPreferences.preferredModels)
        if (currentSignature === loadedPreferencesSignature) return

        // Don't overwrite selections the user already made this session
        const hasActiveSelection = config.some(c => c.model && c.model.trim() !== '')
        if (!hasActiveSelection) {
            aiConfigPreferences.preferredModels.forEach(pref => {
                if (pref.aiVendor && pref.model) {
                    setSelectedModelForAIVendor(pref.aiVendor, pref.model)
                    // Settings-page saves predating thinkingLevel in
                    // preferredModels only stored it on the vendor key item,
                    // so fall back to the key-status list (as AISettings does)
                    const thinkingLevel = pref.thinkingLevel
                        ?? aiVendorAPIKeyStatusList
                            .find(s => s.aiVendor === pref.aiVendor)?.thinkingLevel
                    if (thinkingLevel) {
                        setThinkingLevelForAIVendor(pref.aiVendor, thinkingLevel)
                    }
                }
            })
        }
        setLoadedPreferencesSignature(currentSignature)
    }, [aiConfigPreferences, loadedPreferencesSignature, config, aiVendorAPIKeyStatusList])

    // 🔹 Update or insert vendor+model config safely
    const setSelectedModelForAIVendor = (aiVendor: string, model: string) => {
        if (!aiVendor) return // skip invalid vendor
        setConfig(prevConfigs => {
            const existingIndex = prevConfigs.findIndex(c => c.aiVendor === aiVendor)

            if (existingIndex !== -1) {
                const updated = [...prevConfigs]
                updated[existingIndex] = {
                    ...updated[existingIndex],
                    aiVendor,
                    model: model ?? updated[existingIndex].model ?? '',
                }
                return updated
            }

            // otherwise add new vendor config
            return [
                ...prevConfigs,
                {
                    aiVendor,
                    model: model ?? '',
                },
            ]
        })
    }

    // 🔹 Per-vendor reasoning effort ('' clears back to the vendor default).
    // Only meaningful once the vendor has a config entry (a model selected).
    const setThinkingLevelForAIVendor = (aiVendor: string, thinkingLevel: string) => {
        if (!aiVendor) return
        setConfig(prevConfigs =>
            prevConfigs.map(c =>
                c.aiVendor === aiVendor
                    ? { ...c, thinkingLevel: thinkingLevel || undefined }
                    : c
            )
        )
    }



    const resetConfig = () => {
        try {
            setConfig([])
        } catch (e) {
            console.error('Failed to reset config:', e)
        }
    }

    return (
        <AIContext.Provider
            value={{
                config,
                setSelectedModelForAIVendor,
                setThinkingLevelForAIVendor,
                resetConfig,
                activeBlockId,
                setActiveBlockId,
                supplementalText,
                setSupplementalText,
                customerInstructions,
                systemPrompt,
                setSystemPrompt,
                selectedInstructionId,
                setSelectedInstructionId,
                isSystemPromptLoaded,
                selectedAgentId,
                setSelectedAgentId,
            }}
        >
            {children}
        </AIContext.Provider>
    )
}

export const useAI = (): AIContextType => {
    const ctx = useContext(AIContext)
    if (!ctx) {
        // Graceful fallback instead of throwing
        console.warn('useAI must be used within AIProvider — returning fallback.')
        return {
            config: [],
            setSelectedModelForAIVendor: () => { },
            setThinkingLevelForAIVendor: () => { },
            resetConfig: () => { },
            activeBlockId: '',
            setActiveBlockId: () => { },
            supplementalText: '',
            setSupplementalText: () => { },
            customerInstructions: [],
            systemPrompt: '',
            setSystemPrompt: () => { },
            selectedInstructionId: null,
            setSelectedInstructionId: () => { },
            isSystemPromptLoaded: false,
            selectedAgentId: null,
            setSelectedAgentId: () => { },
        }
    }
    return ctx
}
