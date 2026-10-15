import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { modelsWithoutPdfInput, useModelsWithoutPdfInput } from '../../hooks/useModelsWithoutPdfInput'
import { ProviderCatalogResponse } from '../../services/providerCatalogService'

const mockConfig: { aiVendor: string; model: string }[] = []
jest.mock('../../context/AIContext', () => ({
    useAI: () => ({ config: mockConfig }),
}))
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
    }),
}))

let mockCatalog: ProviderCatalogResponse | null = null
const mockListeners = new Set<() => void>()
jest.mock('../../services/providerCatalogService', () => ({
    getCachedProviderCatalog: () => mockCatalog,
    subscribeProviderCatalog: (listener: () => void) => {
        mockListeners.add(listener)
        return () => mockListeners.delete(listener)
    },
    getProviderCatalog: jest.fn(async () => mockCatalog),
}))

const catalog: ProviderCatalogResponse = {
    providers: [
        {
            id: 'anthropic',
            displayName: 'Anthropic',
            native: true,
            models: [{ name: 'claude-sonnet-4-6', supportsTools: true, supportsPdfInput: true }],
        },
        {
            id: 'openai',
            displayName: 'OpenAI',
            native: true,
            models: [
                { name: 'gpt-5', supportsTools: true, supportsPdfInput: true },
                { name: 'gpt-3.5-turbo', supportsTools: true, supportsPdfInput: false },
            ],
        },
        {
            id: 'deepseek',
            displayName: 'DeepSeek',
            native: false,
            models: [
                { name: 'deepseek-chat', supportsTools: true, supportsPdfInput: false },
                // A catalog entry from a backend predating the flag
                { name: 'deepseek-legacy', supportsTools: true },
            ],
        },
    ],
}

describe('modelsWithoutPdfInput', () => {
    test('names the selected models whose catalog entry says supportsPdfInput=false', () => {
        expect(modelsWithoutPdfInput(
            [
                { aiVendor: 'CLAUDE', model: 'claude-sonnet-4-6' },
                { aiVendor: 'OPENAI', model: 'gpt-3.5-turbo' },
                { aiVendor: 'deepseek', model: 'deepseek-chat' },
            ],
            catalog
        )).toEqual(['gpt-3.5-turbo', 'deepseek-chat'])
    })

    test('no hint for PDF-capable models (e.g. Claude), unknown models or a missing flag', () => {
        expect(modelsWithoutPdfInput([{ aiVendor: 'CLAUDE', model: 'claude-sonnet-4-6' }], catalog)).toEqual([])
        expect(modelsWithoutPdfInput([{ aiVendor: 'OPENAI', model: 'gpt-9-unknown' }], catalog)).toEqual([])
        expect(modelsWithoutPdfInput([{ aiVendor: 'deepseek', model: 'deepseek-legacy' }], catalog)).toEqual([])
        expect(modelsWithoutPdfInput([{ aiVendor: 'groq', model: 'deepseek-chat' }], catalog)).toEqual([])
        expect(modelsWithoutPdfInput([{ aiVendor: 'OPENAI', model: '' }], catalog)).toEqual([])
    })

    test('nothing without a catalog', () => {
        expect(modelsWithoutPdfInput([{ aiVendor: 'deepseek', model: 'deepseek-chat' }], null)).toEqual([])
    })
})

describe('useModelsWithoutPdfInput', () => {
    const Probe = () => <div data-testid="names">{useModelsWithoutPdfInput().join('|')}</div>

    beforeEach(() => {
        mockConfig.length = 0
        mockCatalog = null
        mockListeners.clear()
    })

    test('follows the selection and picks up the catalog once it loads', async () => {
        mockConfig.push({ aiVendor: 'deepseek', model: 'deepseek-chat' }, { aiVendor: 'CLAUDE', model: 'claude-sonnet-4-6' })
        render(<Probe />)
        expect(screen.getByTestId('names')).toHaveTextContent('')

        mockCatalog = catalog
        mockListeners.forEach(listener => listener())

        await waitFor(() => expect(screen.getByTestId('names')).toHaveTextContent('deepseek-chat'))
        const { getProviderCatalog } = require('../../services/providerCatalogService')
        expect(getProviderCatalog).toHaveBeenCalledWith('token')
    })
})
