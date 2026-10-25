import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { EmbeddingUsageSettings } from './EmbeddingUsageSettings'
import { useAuth } from '../../../../context/AuthContext'
import { getEmbeddingUsage } from '../../../../services/getUsageService'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetEmbeddingUsage = getEmbeddingUsage as jest.Mock

describe('EmbeddingUsageSettings', () => {
    const mockGetAccessTokenSilently = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })
    })

    test('renders the title, date picker, and a "not tracked yet" state when the endpoint 404s', async () => {
        mockGetEmbeddingUsage.mockResolvedValue(null)

        render(<EmbeddingUsageSettings />)

        expect(screen.getByText('Embedding Model Usage')).toBeInTheDocument()
        expect(screen.getByTestId('embedding-usage-date-range')).toBeInTheDocument()
        await waitFor(() =>
            expect(screen.getByTestId('embedding-usage-not-tracked-yet')).toBeInTheDocument()
        )
    })

    test('also shows "not tracked yet" if the fetch throws, instead of an error state', async () => {
        mockGetEmbeddingUsage.mockRejectedValue(new Error('boom'))

        render(<EmbeddingUsageSettings />)

        await waitFor(() =>
            expect(screen.getByTestId('embedding-usage-not-tracked-yet')).toBeInTheDocument()
        )
    })

    test('renders totals and breakdowns once the backend returns real usage', async () => {
        mockGetEmbeddingUsage.mockResolvedValue({
            totalCostUsd: 1.5,
            byVendor: [{ vendor: 'VOYAGE', costUsd: 1.5, totalTokens: 1000, requestCount: 5 }],
            byModel: [{ vendor: 'VOYAGE', model: 'voyage-4-large', costUsd: 1.5, totalTokens: 1000, requestCount: 5 }],
        })

        render(<EmbeddingUsageSettings />)

        await waitFor(() => expect(screen.getByTestId('embedding-usage-total-cost')).toBeInTheDocument())
        expect(screen.queryByTestId('embedding-usage-not-tracked-yet')).not.toBeInTheDocument()
        expect(screen.getByTestId('embedding-usage-total-cost')).toHaveTextContent('$1.50')
    })
})
