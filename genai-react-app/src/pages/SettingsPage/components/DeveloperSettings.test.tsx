import React from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeveloperSettings } from './DeveloperSettings'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { createDeveloperApiKey, listDeveloperApiKeys, revokeDeveloperApiKey } from '../../../services/developerApiKeysService'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { renderSettingsPage } from '../settingsTestUtils'

jest.mock('../../../context/AuthContext')
jest.mock('../../../context/ToastContext')
jest.mock('../../../services/developerApiKeysService')

const mockUseAuth = useAuth as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockCreate = createDeveloperApiKey as jest.Mock
const mockList = listDeveloperApiKeys as jest.Mock
const mockRevoke = revokeDeveloperApiKey as jest.Mock

const KEY_SUMMARY = {
    keyId: 'key-1',
    name: 'CI server',
    prefix: 'gfy_abcdefgh',
    createdAt: '2026-01-05T10:00:00Z',
    lastUsedAt: '2026-02-01T10:00:00Z',
    requests30d: 1204,
    costUsd30d: 0.58,
    requestsAllTime: 2_400_000,
    costUsdAllTime: 1.37,
}
const TOTALS = { requests30d: 1204, costUsd30d: 0.58, requestsAllTime: 2_400_000, costUsdAllTime: 1.37 }

const CREATED_KEY = {
    keyId: 'key-2',
    name: 'New key',
    apiKey: 'gfy_fullsecretvalue1234',
    prefix: 'gfy_fullsecr',
    createdAt: '2026-03-01T10:00:00Z',
}

describe('DeveloperSettings', () => {
    const showToast = jest.fn()
    const getAccessTokenSilently = jest.fn()
    const auth = (overrides: Record<string, unknown> = {}) => mockUseAuth.mockReturnValue({
        customerId: 'cust-123',
        isAuthenticated: true,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList: [],
        ...overrides,
    })
    const createKey = async () => {
        await userEvent.type(screen.getByTestId('api-key-name-input'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))
        await screen.findByTestId('created-key-panel')
    }

    beforeEach(() => {
        jest.clearAllMocks()
        getAccessTokenSilently.mockResolvedValue('test-token')
        mockUseToast.mockReturnValue({ showToast })
        auth()
        mockList.mockResolvedValue({ keys: [] })
    })

    test('renders the empty state', async () => {
        renderSettingsPage(<DeveloperSettings />)

        expect(await screen.findByText('No API keys yet.')).toBeInTheDocument()
        expect(mockList).toHaveBeenCalledWith('test-token')
        expect(screen.getByRole('heading', { level: 1, name: 'Developer' })).toBeInTheDocument()
    })

    test('lists each key with its requests and costs, and an All keys row', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY], totals: TOTALS })
        renderSettingsPage(<DeveloperSettings />)

        const row = await screen.findByRole('row', { name: /CI server/ })
        expect(within(row).getByText('gfy_abcdefgh…')).toBeInTheDocument()
        expect(within(row).getByText('1,204')).toBeInTheDocument()
        expect(within(row).getByText('$0.58')).toBeInTheDocument()
        expect(within(row).getByText('$1.37')).toBeInTheDocument()
        const totals = screen.getByRole('row', { name: /All keys/ })
        expect(within(totals).getByText('$1.37')).toBeInTheDocument()
        expect(screen.getAllByText('1 API key').length).toBeGreaterThan(0)
        expect(screen.getByText('$1.37 spent through keys')).toBeInTheDocument()
        expect(screen.getByText('Cost, 30 days')).toBeInTheDocument()
    })

    test('own-key users see the costs as estimates', async () => {
        auth({ aiVendorAPIKeyStatusList: [{ aiVendor: 'OPENAI', isAPIKeyValid: true, status: APIKeyStatus.VALID }] })
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY], totals: TOTALS })
        renderSettingsPage(<DeveloperSettings />)

        expect(await screen.findByText('Est. $1.37 through keys')).toBeInTheDocument()
        expect(screen.getByText('Est. cost, 30 days')).toBeInTheDocument()
    })

    test('shows a dash where usage could not be read or a key was never used', async () => {
        mockList.mockResolvedValue({
            keys: [{ ...KEY_SUMMARY, lastUsedAt: undefined, requests30d: null, costUsd30d: null, costUsdAllTime: null }],
        })
        renderSettingsPage(<DeveloperSettings />)

        const row = await screen.findByRole('row', { name: /CI server/ })
        expect(within(row).getAllByText('—')).toHaveLength(4)
        expect(screen.queryByText(/spent through keys/)).not.toBeInTheDocument()
    })

    test('shows a toast when loading keys fails', async () => {
        mockList.mockRejectedValue(new Error('load failed'))
        renderSettingsPage(<DeveloperSettings />)

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('load failed'))
    })

    test('does not load keys when signed out', () => {
        auth({ customerId: null, isAuthenticated: false })
        renderSettingsPage(<DeveloperSettings />)

        expect(mockList).not.toHaveBeenCalled()
    })

    test('asks for a name before creating', async () => {
        renderSettingsPage(<DeveloperSettings />)

        await userEvent.click(screen.getByTestId('create-api-key'))

        expect(showToast).toHaveBeenCalledWith('Please enter a name for the key.')
        expect(mockCreate).not.toHaveBeenCalled()
    })

    test('creates a key and shows the full value once', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)
        renderSettingsPage(<DeveloperSettings />)

        await createKey()

        expect(mockCreate).toHaveBeenCalledWith('test-token', { name: 'New key' })
        expect(screen.getByTestId('created-key-value')).toHaveTextContent('gfy_fullsecretvalue1234')
        expect(screen.getByText('Key “New key” created')).toBeInTheDocument()
        expect(screen.getByText('Copy it now')).toBeInTheDocument()
        expect(mockList).toHaveBeenCalledTimes(2)
    })

    test('dismisses the created-key card', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)
        renderSettingsPage(<DeveloperSettings />)
        await createKey()

        await userEvent.click(screen.getByTestId('created-key-dismiss'))

        expect(screen.queryByTestId('created-key-panel')).not.toBeInTheDocument()
    })

    test('shows a toast when creation fails', async () => {
        mockCreate.mockRejectedValue(new Error('create failed'))
        renderSettingsPage(<DeveloperSettings />)

        await userEvent.type(screen.getByTestId('api-key-name-input'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('create failed'))
        expect(screen.queryByTestId('created-key-panel')).not.toBeInTheDocument()
    })

    test('copies the created key to the clipboard', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)
        const writeText = jest.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        renderSettingsPage(<DeveloperSettings />)
        await createKey()

        await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('gfy_fullsecretvalue1234'))
        expect(showToast).toHaveBeenCalledWith('API key copied to clipboard.')
    })

    test('revokes a key only after confirming in the dialog', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY], totals: TOTALS })
        mockRevoke.mockResolvedValue(undefined)
        renderSettingsPage(<DeveloperSettings />)

        await userEvent.click(await screen.findByTestId('revoke-key-key-1'))
        expect(screen.getByRole('heading', { name: 'Revoke “CI server”?' })).toBeInTheDocument()
        expect(mockRevoke).not.toHaveBeenCalled()
        await userEvent.click(screen.getByTestId('revoke-key-confirm'))

        await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('test-token', 'key-1'))
        expect(showToast).toHaveBeenCalledWith('API key revoked.')
    })

    test('cancelling the dialog keeps the key', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY] })
        renderSettingsPage(<DeveloperSettings />)

        await userEvent.click(await screen.findByTestId('revoke-key-key-1'))
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(mockRevoke).not.toHaveBeenCalled()
        expect(screen.queryByTestId('revoke-key-confirm')).not.toBeInTheDocument()
    })

    test('shows a toast when revoking fails', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY] })
        mockRevoke.mockRejectedValue(new Error('revoke failed'))
        renderSettingsPage(<DeveloperSettings />)

        await userEvent.click(await screen.findByTestId('revoke-key-key-1'))
        await userEvent.click(screen.getByTestId('revoke-key-confirm'))

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('revoke failed'))
    })
})
