import React, { createContext, useContext, useState, ReactNode } from 'react'
import { AIVendor } from '../constants/vendors'

/**
 * Base configuration for AI generation — scalable beyond vendor selection.
 */
export interface AIConfig {
    vendorSelections: Record<AIVendor, string> // Vendor → Selected Model
    temperature: number
    maxTokens: number
    tone?: string
}

interface AIContextType {
    config: AIConfig
    setVendorModel: (vendor: AIVendor, model: string | null) => void
    setTemperature: (temp: number) => void
    setMaxTokens: (max: number) => void
    setTone: (tone: string) => void
    resetConfig: () => void
}

const AIContext = createContext<AIContextType | undefined>(undefined)

/**
 * Default initial config — generated dynamically from AIVendor enum.
 */
const defaultVendorSelections: Record<AIVendor, string> = Object.values(AIVendor).reduce(
    (acc, vendor) => {
        acc[vendor as AIVendor] = ''
        return acc
    },
    {} as Record<AIVendor, string>
)

const defaultConfig: AIConfig = {
    vendorSelections: defaultVendorSelections,
    temperature: 0.7,
    maxTokens: 1024,
    tone: 'neutral',
}

export const AIProvider = ({ children }: { children: ReactNode }) => {
    const [config, setConfig] = useState<AIConfig>(defaultConfig)

    const setVendorModel = (vendor: AIVendor, model: string | null) => {
        setConfig(prev => {
            const updatedSelections = { ...prev.vendorSelections }
            if (model) updatedSelections[vendor] = model
            else updatedSelections[vendor] = ''
            return { ...prev, vendorSelections: updatedSelections }
        })
    }

    const setTemperature = (temp: number) => setConfig(prev => ({ ...prev, temperature: temp }))
    const setMaxTokens = (max: number) => setConfig(prev => ({ ...prev, maxTokens: max }))
    const setTone = (tone: string) => setConfig(prev => ({ ...prev, tone }))
    const resetConfig = () => setConfig(defaultConfig)

    return (
        <AIContext.Provider
            value={{
                config,
                setVendorModel,
                setTemperature,
                setMaxTokens,
                setTone,
                resetConfig,
            }}
        >
            {children}
        </AIContext.Provider>
    )
}

export const useAI = (): AIContextType => {
    const ctx = useContext(AIContext)
    if (!ctx) throw new Error('useAI must be used within an AIProvider')
    return ctx
}
