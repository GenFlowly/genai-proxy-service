import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { VectorDbUsageSettings } from './VectorDbUsageSettings'
import { useAuth } from '../../../../context/AuthContext'
import { getVectorDbUsage } from '../../../../services/getUsageService'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetVectorDbUsage = getVectorDbUsage as jest.Mock

describe('VectorDbUsageSettings', () => {
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
        mockGetVectorDbUsage.mockResolvedValue(null)

        render(<VectorDbUsageSettings />)

        expect(screen.getByText('Vector DB Usage')).toBeInTheDocument()
        expect(screen.getByTestId('vector-db-usage-date-range')).toBeInTheDocument()
        await waitFor(() =>
            expect(screen.getByTestId('vector-db-usage-not-tracked-yet')).toBeInTheDocument()
        )
    })

    test('also shows "not tracked yet" if the fetch throws, instead of an error state', async () => {
        mockGetVectorDbUsage.mockRejectedValue(new Error('boom'))

        render(<VectorDbUsageSettings />)

        await waitFor(() =>
            expect(screen.getByTestId('vector-db-usage-not-tracked-yet')).toBeInTheDocument()
        )
    })

    test('renders totals, the operation breakdown, and the estimate disclaimer once the backend returns real usage', async () => {
        mockGetVectorDbUsage.mockResolvedValue({
            totalCostUsd: 2.5,
            isEstimate: true,
            breakdown: [
                { key: 'search', count: 100, costUsd: 2.0 },
                { key: 'insert', count: 50, costUsd: 0.5 },
            ],
        })

        render(<VectorDbUsageSettings />)

        await waitFor(() => expect(screen.getByTestId('vector-db-usage-total-cost')).toBeInTheDocument())
        expect(screen.queryByTestId('vector-db-usage-not-tracked-yet')).not.toBeInTheDocument()
        expect(screen.getByTestId('vector-db-usage-estimate-banner')).toBeInTheDocument()
        expect(screen.getByTestId('vector-db-usage-total-cost')).toHaveTextContent('$2.50')
        expect(screen.getByText('search')).toBeInTheDocument()
        expect(screen.getByText('insert')).toBeInTheDocument()
    })
})
