import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'
import { InstructionResponse } from '../models/instruction.models'
import { useAuth } from './AuthContext'

export interface AIConfig {
    aiVendor: AIVendor
    model: string
}

interface AIContextType {
    config: AIConfig[]
    setSelectedModelForAIVendor: (aiVendor: AIVendor, model: string) => void
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
}

const AIContext = createContext<AIContextType | undefined>(undefined)

export const AIProvider = ({ children }: { children: ReactNode }) => {
    const [config, setConfig] = useState<AIConfig[]>([])
    const [activeBlockId, setActiveBlockId] = useState<string>('')
    const [supplementalText, setSupplementalText] = useState<string>('')
    const { customerInstructions, customerId } = useAuth()
    const [systemPrompt, setSystemPrompt] = useState<string>('')
    const [selectedInstructionId, setSelectedInstructionId] = useState<string | null>(null)
    const [isSystemPromptLoaded, setIsSystemPromptLoaded] = useState<boolean>(false)

    // 🔹 Restore from localStorage
    useEffect(() => {
        if (customerId) {
            const savedPrompt = localStorage.getItem(`${customerId}_system_prompt`)
            const savedInstructionId = localStorage.getItem(`${customerId}_selected_instruction_id`)

            setSystemPrompt(savedPrompt || '')
            setSelectedInstructionId(savedInstructionId || null)
            setIsSystemPromptLoaded(true)
        } else {
            setIsSystemPromptLoaded(false)
        }
    }, [customerId])

    // 🔹 Persist to localStorage
    useEffect(() => {
        if (customerId && isSystemPromptLoaded) {
            const promptKey = `${customerId}_system_prompt`
            const idKey = `${customerId}_selected_instruction_id`

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
        }
    }, [systemPrompt, selectedInstructionId, customerId, isSystemPromptLoaded])

    // 🔹 Update or insert vendor+model config safely
    const setSelectedModelForAIVendor = (aiVendor: AIVendor, model: string) => {
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
        }
    }
    return ctx
}
