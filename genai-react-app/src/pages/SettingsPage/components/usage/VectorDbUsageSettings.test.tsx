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

    test('renders the operation breakdown and the no-cost note once the backend returns real usage, with no dollar figure anywhere', async () => {
        mockGetVectorDbUsage.mockResolvedValue({
            breakdown: [
                { opType: 'search', count: 100 },
                { opType: 'insert', count: 50 },
            ],
        })

        render(<VectorDbUsageSettings />)

        await waitFor(() => expect(screen.getByTestId('vector-db-usage-no-cost-note')).toBeInTheDocument())
        expect(screen.queryByTestId('vector-db-usage-not-tracked-yet')).not.toBeInTheDocument()
        expect(screen.getByText('search')).toBeInTheDocument()
        expect(screen.getByText('insert')).toBeInTheDocument()
        expect(screen.getByText('100')).toBeInTheDocument()
        expect(screen.getByText('50')).toBeInTheDocument()
        expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
    })
})
