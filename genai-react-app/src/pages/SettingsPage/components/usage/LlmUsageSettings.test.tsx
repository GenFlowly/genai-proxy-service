import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LlmUsageSettings } from './LlmUsageSettings'
import { defaultUsageRange, localToday, toUtcUsageRange } from './usageDateRange'
import { useAuth } from '../../../../context/AuthContext'
import { getLlmUsage } from '../../../../services/getUsageService'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetLlmUsage = getLlmUsage as jest.Mock

describe('LlmUsageSettings', () => {
    const mockGetAccessTokenSilently = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })
    })

    test('loads and renders totals plus vendor/model breakdowns', async () => {
        mockGetLlmUsage.mockResolvedValue({
            totalCostUsd: 12.3456,
            byVendor: [
                { vendor: 'ANTHROPIC', costUsd: 10, totalTokens: 1000, requestCount: 5 },
                { vendor: 'OPENAI', costUsd: 2.3456, totalTokens: 200, requestCount: 2 },
            ],
            byModel: [
                { vendor: 'ANTHROPIC', model: 'claude-sonnet-5', costUsd: 10, totalTokens: 1000, requestCount: 5 },
                { vendor: 'OPENAI', model: 'gpt-5', costUsd: 2.3456, totalTokens: 200, requestCount: 2 },
            ],
        })

        render(<LlmUsageSettings />)

        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalled())

        expect(screen.getByTestId('llm-usage-total-cost')).toHaveTextContent('$12.35')
        expect(screen.getByTestId('llm-usage-total-requests')).toHaveTextContent('7')
        // Appears once in the "by vendor" table and once in "by model"
        expect(screen.getAllByText('ANTHROPIC')).toHaveLength(2)
        expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument()
    })

    test('calls getLlmUsage with a trailing 30-day default range', async () => {
        mockGetLlmUsage.mockResolvedValue({ totalCostUsd: 0, byVendor: [], byModel: [] })

        render(<LlmUsageSettings />)

        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalledTimes(1))
        const [, range] = mockGetLlmUsage.mock.calls[0]
        expect(range).toEqual(toUtcUsageRange(defaultUsageRange()))
    })

    test('renders the empty state when there is no usage for the range', async () => {
        mockGetLlmUsage.mockResolvedValue({ totalCostUsd: 0, byVendor: [], byModel: [] })

        render(<LlmUsageSettings />)

        await waitFor(() => expect(screen.getByTestId('llm-usage-empty')).toBeInTheDocument())
    })

    test('renders an error state when the fetch fails', async () => {
        mockGetLlmUsage.mockRejectedValue(new Error('boom'))

        render(<LlmUsageSettings />)

        await waitFor(() => expect(screen.getByTestId('llm-usage-error')).toBeInTheDocument())
    })

    test('selecting a different preset refetches with the new range', async () => {
        mockGetLlmUsage.mockResolvedValue({ totalCostUsd: 0, byVendor: [], byModel: [] })

        render(<LlmUsageSettings />)
        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalledTimes(1))

        await userEvent.click(screen.getByTestId('llm-usage-date-range-presets-option-7d'))

        await waitFor(() => expect(mockGetLlmUsage).toHaveBeenCalledTimes(2))
        const [, secondRange] = mockGetLlmUsage.mock.calls[1]
        const from = new Date(`${localToday()}T00:00:00Z`)
        from.setUTCDate(from.getUTCDate() - 6)
        expect(secondRange).toEqual(toUtcUsageRange({ from: from.toISOString().slice(0, 10), to: localToday() }))
    })
})
