import React from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WebSearchToolSettings } from './WebSearchToolSettings'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { deleteToolCredentials, getToolCredentialStatuses, storeToolCredentials } from '../../../services/customerToolsService'
import { renderSettingsPage } from '../settingsTestUtils'

jest.mock('../../../context/AuthContext')
jest.mock('../../../context/ToastContext')
jest.mock('../../../services/customerToolsService', () => ({
    getToolCredentialStatuses: jest.fn(),
    storeToolCredentials: jest.fn(),
    deleteToolCredentials: jest.fn(),
}))

const mockUseAuth = useAuth as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockStatuses = getToolCredentialStatuses as jest.Mock
const mockStore = storeToolCredentials as jest.Mock
const mockDelete = deleteToolCredentials as jest.Mock

const stored = (connected: boolean, settings?: Record<string, string>) => ({
    toolCredentialStatuses: connected ? [{ toolType: 'WEB_SEARCH', authType: 'api_key', connected: true, settings }] : [],
})

describe('WebSearchToolSettings', () => {
    const getAccessTokenSilently = jest.fn()
    const showToast = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        getAccessTokenSilently.mockResolvedValue('test-token')
        mockUseAuth.mockReturnValue({ isAuthenticated: true, getAccessTokenSilently })
        mockUseToast.mockReturnValue({ showToast })
        mockStatuses.mockResolvedValue(stored(false))
        mockStore.mockResolvedValue({})
        mockDelete.mockResolvedValue(undefined)
    })

    test('shows "Not set" and no remove button when no key is stored', async () => {
        renderSettingsPage(<WebSearchToolSettings />)

        expect(await screen.findByTestId('web-search-credential-status-pill')).toHaveTextContent('Not set')
        expect(screen.getByRole('heading', { level: 1, name: 'Web Search API Key' })).toBeInTheDocument()
        expect(screen.queryByTestId('web-search-credential-remove')).not.toBeInTheDocument()
    })

    test('shows "Key set" and a remove button when a key is stored', async () => {
        mockStatuses.mockResolvedValue(stored(true))
        renderSettingsPage(<WebSearchToolSettings />)

        expect(await screen.findByTestId('web-search-credential-remove')).toBeInTheDocument()
        expect(screen.getByTestId('web-search-credential-status-pill')).toHaveTextContent('Key set')
    })

    test('saves the key under toolType WEB_SEARCH with authType api_key, then reloads', async () => {
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-status-pill')

        await userEvent.type(screen.getByTestId('web-search-credential-key-input'), 'tvly-secret-key')
        await userEvent.click(screen.getByTestId('web-search-credential-save'))

        await waitFor(() => expect(mockStore).toHaveBeenCalledWith('test-token', {
            toolType: 'WEB_SEARCH',
            authType: 'api_key',
            credentials: { api_key: 'tvly-secret-key' },
        }))
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Key saved.'))
        expect(mockStatuses).toHaveBeenCalledTimes(2)
        expect(screen.getByTestId('web-search-credential-key-input')).toHaveValue('')
    })

    test('the save button stays disabled for an empty key', async () => {
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-status-pill')

        expect(screen.getByTestId('web-search-credential-save')).toBeDisabled()
    })

    test('removes the key only after confirming in the dialog', async () => {
        mockStatuses.mockResolvedValue(stored(true))
        renderSettingsPage(<WebSearchToolSettings />)

        await userEvent.click(await screen.findByTestId('web-search-credential-remove'))
        expect(mockDelete).not.toHaveBeenCalled()
        await userEvent.click(screen.getByTestId('web-search-credential-remove-confirm'))

        await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('test-token', 'WEB_SEARCH'))
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Key removed.'))
    })

    test('cancelling the dialog keeps the key', async () => {
        mockStatuses.mockResolvedValue(stored(true))
        renderSettingsPage(<WebSearchToolSettings />)

        await userEvent.click(await screen.findByTestId('web-search-credential-remove'))
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(mockDelete).not.toHaveBeenCalled()
        expect(screen.queryByTestId('web-search-credential-remove-confirm')).not.toBeInTheDocument()
    })

    test('shows the server error message when saving fails', async () => {
        mockStore.mockRejectedValue(new Error('Tavily rejected the key'))
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-status-pill')

        await userEvent.type(screen.getByTestId('web-search-credential-key-input'), 'bad')
        await userEvent.click(screen.getByTestId('web-search-credential-save'))

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Tavily rejected the key'))
    })

    test('shows the default limit of 5 with its save button disabled', async () => {
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-status-pill')

        expect(screen.getByTestId('web-search-limit-input')).toHaveValue(5)
        expect(screen.getByTestId('web-search-limit-save')).toBeDisabled()
    })

    test('shows the stored limit', async () => {
        mockStatuses.mockResolvedValue(stored(true, { max_searches_per_turn: '12' }))
        renderSettingsPage(<WebSearchToolSettings />)

        await waitFor(() => expect(screen.getByTestId('web-search-limit-input')).toHaveValue(12))
    })

    test('saves a changed limit as settings only, never touching credentials', async () => {
        mockStatuses.mockResolvedValue(stored(true))
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-remove')

        const input = screen.getByTestId('web-search-limit-input')
        await userEvent.clear(input)
        await userEvent.type(input, '8')
        await userEvent.click(screen.getByTestId('web-search-limit-save'))

        await waitFor(() => expect(mockStore).toHaveBeenCalledWith('test-token', {
            toolType: 'WEB_SEARCH',
            authType: 'api_key',
            settings: { max_searches_per_turn: '8' },
        }))
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Search limit saved.'))
    })

    test('keeps the limit save button disabled out of bounds', async () => {
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-status-pill')

        const input = screen.getByTestId('web-search-limit-input')
        await userEvent.clear(input)
        await userEvent.type(input, '21')

        expect(screen.getByTestId('web-search-limit-save')).toBeDisabled()
    })

    test('links to its usage page', async () => {
        renderSettingsPage(<WebSearchToolSettings />)
        await screen.findByTestId('web-search-credential-status-pill')

        expect(screen.getByRole('link', { name: 'Cost and Usage' })).toHaveAttribute('href', '/settings/usage/web-search')
    })
})
