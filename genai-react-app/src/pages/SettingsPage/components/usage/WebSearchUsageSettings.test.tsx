import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { WebSearchUsageSettings } from './WebSearchUsageSettings'
import { useAuth } from '../../../../context/AuthContext'
import { getWebSearchUsage } from '../../../../services/getUsageService'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetWebSearchUsage = getWebSearchUsage as jest.Mock

describe('WebSearchUsageSettings', () => {
    const mockGetAccessTokenSilently = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })
    })

    test('renders the date picker and a "not tracked yet" state when the endpoint 404s', async () => {
        mockGetWebSearchUsage.mockResolvedValue(null)

        render(<WebSearchUsageSettings />)

        expect(screen.getByTestId('web-search-usage-date-range')).toBeInTheDocument()
        await waitFor(() =>
            expect(screen.getByTestId('web-search-usage-not-tracked-yet')).toBeInTheDocument()
        )
    })

    test('also shows "not tracked yet" if the fetch throws, instead of an error state', async () => {
        mockGetWebSearchUsage.mockRejectedValue(new Error('boom'))

        render(<WebSearchUsageSettings />)

        await waitFor(() =>
            expect(screen.getByTestId('web-search-usage-not-tracked-yet')).toBeInTheDocument()
        )
    })

    test('renders totals, the search-depth breakdown, and the estimate disclaimer once the backend returns real usage', async () => {
        mockGetWebSearchUsage.mockResolvedValue({
            totalCostUsd: 0.75,
            isEstimate: true,
            breakdown: [
                { key: 'basic', count: 50, costUsd: 0.5 },
                { key: 'advanced', count: 5, costUsd: 0.25 },
            ],
        })

        render(<WebSearchUsageSettings />)

        await waitFor(() => expect(screen.getByTestId('web-search-usage-total-cost')).toBeInTheDocument())
        expect(screen.queryByTestId('web-search-usage-not-tracked-yet')).not.toBeInTheDocument()
        expect(screen.getByTestId('web-search-usage-estimate-banner')).toBeInTheDocument()
        expect(screen.getByTestId('web-search-usage-total-cost')).toHaveTextContent('$0.7500')
        expect(screen.getByText('basic')).toBeInTheDocument()
        expect(screen.getByText('advanced')).toBeInTheDocument()
    })
})
