import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LlmUsageSettings } from './LlmUsageSettings'
import { defaultUsageRange, localToday, toUtcUsageRange } from './usageDateRange'
import { useAuth } from '../../../../context/AuthContext'
import { getLlmUsage } from '../../../../services/getUsageService'
import { APIKeyStatus } from '../../../../models/storeCustomerVendorAPIKeys.models'
import { withQueryClient } from '../../../../test/utils/queryWrapper'
import { renderSettingsPage } from '../../settingsTestUtils'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetLlmUsage = getLlmUsage as jest.Mock

const SUMMARY = {
    totalCostUsd: 12.3456,
    byVendor: [
        { vendor: 'CLAUDE', costUsd: 10, totalTokens: 1_250_000, cacheReadTokens: 900_000, cacheWriteTokens: 200_000, requestCount: 5 },
        { vendor: 'OPENAI', costUsd: 2.3456, totalTokens: 200, requestCount: 2 },
    ],
    byModel: [
        { vendor: 'CLAUDE', model: 'claude-sonnet-5', costUsd: 10, totalTokens: 1_250_000, requestCount: 5 },
        { vendor: 'OPENAI', model: 'gpt-5', costUsd: 2.3456, totalTokens: 200, requestCount: 2 },
    ],
    byDay: [{ date: localToday(), costUsd: 12.3456, requestCount: 7 }],
}
const EMPTY = { totalCostUsd: 0, byVendor: [], byModel: [], byDay: [] }

describe('LlmUsageSettings', () => {
    const getAccessTokenSilently = jest.fn()
    const auth = (overrides: Record<string, unknown> = {}) => mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList: [],
        ...overrides,
    })
    const renderPage = () => renderSettingsPage(withQueryClient(<LlmUsageSettings />))

    beforeEach(() => {
        jest.clearAllMocks()
        getAccessTokenSilently.mockResolvedValue('test-token')
        auth()
    })

    test('shows the four tiles, with millions shortened, and the vendor and model tables', async () => {
        mockGetLlmUsage.mockResolvedValue(SUMMARY)
        renderPage()

        expect(await screen.findByTestId('llm-usage-tile-cost')).toHaveTextContent('Total cost$12.35')
        expect(screen.getByTestId('llm-usage-tile-requests')).toHaveTextContent('7')
        expect(screen.getByTestId('llm-usage-tile-tokens')).toHaveTextContent('1.3M')
        expect(screen.getByTestId('llm-usage-tile-cache')).toHaveTextContent('1.1M')
        const byModel = screen.getByTestId('llm-usage-by-model')
        expect(within(byModel).getByText('claude-sonnet-5')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Cost per day' })).toBeInTheDocument()
        expect(screen.getByText("From each model's prices.")).toBeInTheDocument()
    })

    test('own-key users see an estimate', async () => {
        auth({ aiVendorAPIKeyStatusList: [{ aiVendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }] })
        mockGetLlmUsage.mockResolvedValue(SUMMARY)
        renderPage()

        expect(await screen.findByTestId('llm-usage-tile-cost')).toHaveTextContent('Est. cost')
        expect(screen.getByText('Based on your usage. Your BYOK provider bill may vary.')).toBeInTheDocument()
    })

    test('asks for the trailing 30 days first and labels the page with it', async () => {
        mockGetLlmUsage.mockResolvedValue(EMPTY)
        renderPage()

        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalledTimes(1))
        expect(mockGetLlmUsage.mock.calls[0][1]).toEqual(toUtcUsageRange(defaultUsageRange()))
        expect(screen.getAllByText('Last 30 days').length).toBeGreaterThan(1)
    })

    test('an empty range shows empty tables', async () => {
        mockGetLlmUsage.mockResolvedValue(EMPTY)
        renderPage()

        expect((await screen.findAllByText('No usage in this range.')).length).toBe(2)
    })

    test('a failed fetch shows the error', async () => {
        mockGetLlmUsage.mockRejectedValue(new Error('boom'))
        renderPage()

        expect(await screen.findByTestId('llm-usage-error')).toBeInTheDocument()
    })

    test('picking another preset refetches with that range', async () => {
        mockGetLlmUsage.mockResolvedValue(EMPTY)
        renderPage()
        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalledTimes(1))

        await userEvent.click(screen.getByTestId('llm-usage-date-range-preset-7d'))

        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalledTimes(2))
        const from = new Date(`${localToday()}T00:00:00Z`)
        from.setUTCDate(from.getUTCDate() - 6)
        expect(mockGetLlmUsage.mock.calls[1][1]).toEqual(toUtcUsageRange({ from: from.toISOString().slice(0, 10), to: localToday() }))
    })
})
