import React from 'react'
import { screen, within } from '@testing-library/react'
import { VectorDbUsageSettings } from './VectorDbUsageSettings'
import { useAuth } from '../../../../context/AuthContext'
import { getVectorDbUsage } from '../../../../services/getUsageService'
import { renderSettingsPage } from '../../settingsTestUtils'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetVectorDbUsage = getVectorDbUsage as jest.Mock

describe('VectorDbUsageSettings', () => {
    const getAccessTokenSilently = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        getAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({ isAuthenticated: true, getAccessTokenSilently })
    })

    test('shows "Not tracked yet" with a link to the connection when the route is not live', async () => {
        mockGetVectorDbUsage.mockResolvedValue(null)
        renderSettingsPage(<VectorDbUsageSettings />)

        const card = await screen.findByTestId('vector-db-usage-not-tracked-yet')
        expect(within(card).getByRole('link', { name: 'Vector DB Connection' })).toHaveAttribute('href', '/settings/byok/vector-db')
        expect(screen.getAllByText('Not tracked yet').length).toBeGreaterThan(1)
    })

    test('also shows "Not tracked yet" if the fetch throws', async () => {
        mockGetVectorDbUsage.mockRejectedValue(new Error('boom'))
        renderSettingsPage(<VectorDbUsageSettings />)

        expect(await screen.findByTestId('vector-db-usage-not-tracked-yet')).toBeInTheDocument()
    })

    test('lists operation counts, never a dollar figure', async () => {
        mockGetVectorDbUsage.mockResolvedValue({ breakdown: [{ opType: 'search', count: 2_500_000 }, { opType: 'insert', count: 12 }] })
        renderSettingsPage(<VectorDbUsageSettings />)

        const table = await screen.findByTestId('vector-db-usage-table')
        expect(within(table).getByText('2.5M')).toBeInTheDocument()
        expect(within(table).getByText('12')).toBeInTheDocument()
        expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
    })
})
