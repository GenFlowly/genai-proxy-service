import React from 'react'
import { screen, within } from '@testing-library/react'
import { EmbeddingUsageSettings } from './EmbeddingUsageSettings'
import { useAuth } from '../../../../context/AuthContext'
import { getEmbeddingUsage } from '../../../../services/getUsageService'
import { withQueryClient } from '../../../../test/utils/queryWrapper'
import { renderSettingsPage } from '../../settingsTestUtils'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../services/getUsageService')

const mockUseAuth = useAuth as jest.Mock
const mockGetEmbeddingUsage = getEmbeddingUsage as jest.Mock

describe('EmbeddingUsageSettings', () => {
    const getAccessTokenSilently = jest.fn()
    const renderPage = () => renderSettingsPage(withQueryClient(<EmbeddingUsageSettings />))

    beforeEach(() => {
        jest.clearAllMocks()
        getAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({ isAuthenticated: true, getAccessTokenSilently, aiVendorAPIKeyStatusList: [] })
    })

    test('shows "Not tracked yet" when the route is not live', async () => {
        mockGetEmbeddingUsage.mockResolvedValue(null)
        renderPage()

        expect(await screen.findByTestId('embedding-usage-not-tracked-yet')).toBeInTheDocument()
        expect(screen.getByTestId('embedding-usage-date-range')).toBeInTheDocument()
    })

    test('shows three tiles (no cache tokens) and names Voyage AI in the tables', async () => {
        mockGetEmbeddingUsage.mockResolvedValue({
            totalCostUsd: 0.21,
            byVendor: [{ vendor: 'VOYAGE', costUsd: 0.21, totalTokens: 1_700_000, requestCount: 1140 }],
            byModel: [{ vendor: 'VOYAGE', model: 'voyage-4-large', costUsd: 0.21, totalTokens: 1_700_000, requestCount: 1140 }],
            byDay: [],
        })
        renderPage()

        expect(await screen.findByTestId('embedding-usage-tile-cost')).toHaveTextContent('$0.21')
        expect(screen.getByTestId('embedding-usage-tile-requests')).toHaveTextContent('1,140')
        expect(screen.getByTestId('embedding-usage-tile-tokens')).toHaveTextContent('1.7M')
        expect(screen.queryByTestId('embedding-usage-tile-cache')).not.toBeInTheDocument()
        expect(within(screen.getByTestId('embedding-usage-by-vendor')).getByText('Voyage AI')).toBeInTheDocument()
        expect(screen.getByText('Why it can be zero')).toBeInTheDocument()
    })
})
