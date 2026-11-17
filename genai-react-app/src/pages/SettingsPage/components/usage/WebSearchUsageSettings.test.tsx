import React from 'react'
import { screen, within } from '@testing-library/react'
import { WebSearchUsageSettings } from './WebSearchUsageSettings'
import { useAuth } from '../../../../context/AuthContext'
import { getWebSearchUsage } from '../../../../services/getUsageService'
import { renderSettingsPage } from '../../settingsTestUtils'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetWebSearchUsage = getWebSearchUsage as jest.Mock

describe('WebSearchUsageSettings', () => {
    const getAccessTokenSilently = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        getAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({ isAuthenticated: true, getAccessTokenSilently })
    })

    test('shows "Not tracked yet" with a link to the search limit when the route is not live', async () => {
        mockGetWebSearchUsage.mockResolvedValue(null)
        renderSettingsPage(<WebSearchUsageSettings />)

        const card = await screen.findByTestId('web-search-usage-not-tracked-yet')
        expect(within(card).getByRole('link', { name: 'Change search limit' })).toHaveAttribute('href', '/settings/byok/web-search')
    })

    test('also shows "Not tracked yet" if the fetch throws', async () => {
        mockGetWebSearchUsage.mockRejectedValue(new Error('boom'))
        renderSettingsPage(<WebSearchUsageSettings />)

        expect(await screen.findByTestId('web-search-usage-not-tracked-yet')).toBeInTheDocument()
    })

    test('lists credits and the estimated cost per search depth, with a total', async () => {
        mockGetWebSearchUsage.mockResolvedValue({
            totalCostUsd: 0.12,
            isEstimate: true,
            breakdown: [{ key: 'basic', count: 10, costUsd: 0.08 }, { key: 'advanced', count: 4, costUsd: 0.04 }],
        })
        renderSettingsPage(<WebSearchUsageSettings />)

        const table = await screen.findByTestId('web-search-usage-table')
        expect(within(table).getByText('basic')).toBeInTheDocument()
        expect(within(table).getByText('Est. cost')).toBeInTheDocument()
        expect(within(table).getByText('$0.12')).toBeInTheDocument()
    })
})
