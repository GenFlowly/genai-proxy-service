import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeveloperSettings } from './DeveloperSettings'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import {
    createDeveloperApiKey,
    listDeveloperApiKeys,
    revokeDeveloperApiKey,
} from '../../../services/developerApiKeysService'

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
}

const CREATED_KEY = {
    keyId: 'key-2',
    name: 'New key',
    apiKey: 'gfy_fullsecretvalue1234',
    prefix: 'gfy_fullsecr',
    createdAt: '2026-03-01T10:00:00Z',
}

describe('DeveloperSettings', () => {
    const mockShowToast = jest.fn()
    const mockGetAccessTokenSilently = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAccessTokenSilently.mockResolvedValue('test-token')
        mockUseToast.mockReturnValue({ showToast: mockShowToast })
        mockUseAuth.mockReturnValue({
            customerId: 'cust-123',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })
        mockList.mockResolvedValue({ keys: [] })
    })

    test('renders empty state', async () => {
        render(<DeveloperSettings />)

        await waitFor(() => {
            expect(screen.getByText('No API keys yet.')).toBeInTheDocument()
        })
        expect(mockList).toHaveBeenCalledWith('test-token')
    })

    test('renders existing keys with prefix and dates', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY] })

        render(<DeveloperSettings />)

        await waitFor(() => {
            expect(screen.getByText('CI server')).toBeInTheDocument()
        })
        expect(screen.getByText('gfy_abcdefgh…')).toBeInTheDocument()
        expect(screen.getByText('Revoke')).toBeInTheDocument()
    })

    test('shows a toast when loading keys fails', async () => {
        mockList.mockRejectedValue(new Error('load failed'))

        render(<DeveloperSettings />)

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('load failed')
        })
    })

    test('does not load keys when unauthenticated', async () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })

        render(<DeveloperSettings />)

        expect(mockList).not.toHaveBeenCalled()
    })

    test('shows toast when creating without a name', async () => {
        render(<DeveloperSettings />)

        await userEvent.click(screen.getByTestId('create-api-key'))

        expect(mockShowToast).toHaveBeenCalledWith('Please enter a name for the key.')
        expect(mockCreate).not.toHaveBeenCalled()
    })

    test('shows toast when creating while unauthenticated', async () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })

        render(<DeveloperSettings />)
        await userEvent.click(screen.getByTestId('create-api-key'))

        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.')
        expect(mockCreate).not.toHaveBeenCalled()
    })

    test('creates a key and shows the full value once', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)

        render(<DeveloperSettings />)
        await userEvent.type(screen.getByPlaceholderText('e.g. My CI server'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))

        await waitFor(() => {
            expect(screen.getByTestId('created-key-panel')).toBeInTheDocument()
        })
        expect(mockCreate).toHaveBeenCalledWith('test-token', { name: 'New key' })
        expect(screen.getByText('gfy_fullsecretvalue1234')).toBeInTheDocument()
        // List refreshed after creation: initial load + post-create
        expect(mockList).toHaveBeenCalledTimes(2)
    })

    test('dismisses the created-key panel', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)

        render(<DeveloperSettings />)
        await userEvent.type(screen.getByPlaceholderText('e.g. My CI server'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))
        await waitFor(() => {
            expect(screen.getByTestId('created-key-panel')).toBeInTheDocument()
        })

        await userEvent.click(screen.getByText("I've saved my key"))

        expect(screen.queryByTestId('created-key-panel')).not.toBeInTheDocument()
    })

    test('shows a toast when creation fails', async () => {
        mockCreate.mockRejectedValue(new Error('create failed'))

        render(<DeveloperSettings />)
        await userEvent.type(screen.getByPlaceholderText('e.g. My CI server'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('create failed')
        })
        expect(screen.queryByTestId('created-key-panel')).not.toBeInTheDocument()
    })

    test('copies the created key to the clipboard', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)
        const writeText = jest.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        render(<DeveloperSettings />)
        await userEvent.type(screen.getByPlaceholderText('e.g. My CI server'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))
        await waitFor(() => {
            expect(screen.getByTestId('created-key-panel')).toBeInTheDocument()
        })

        await userEvent.click(screen.getByText('Copy'))

        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('gfy_fullsecretvalue1234')
            expect(mockShowToast).toHaveBeenCalledWith('API key copied to clipboard.')
        })
    })

    test('shows fallback toast when clipboard copy fails', async () => {
        mockCreate.mockResolvedValue(CREATED_KEY)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
            configurable: true,
        })

        render(<DeveloperSettings />)
        await userEvent.type(screen.getByPlaceholderText('e.g. My CI server'), 'New key')
        await userEvent.click(screen.getByTestId('create-api-key'))
        await waitFor(() => {
            expect(screen.getByTestId('created-key-panel')).toBeInTheDocument()
        })

        await userEvent.click(screen.getByText('Copy'))

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith(
                'Could not copy — please select and copy the key manually.'
            )
        })
    })

    test('revokes a key after confirmation', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY] })
        mockRevoke.mockResolvedValue(undefined)
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

        render(<DeveloperSettings />)
        await waitFor(() => {
            expect(screen.getByText('Revoke')).toBeInTheDocument()
        })

        await userEvent.click(screen.getByText('Revoke'))

        await waitFor(() => {
            expect(mockRevoke).toHaveBeenCalledWith('test-token', 'key-1')
            expect(mockShowToast).toHaveBeenCalledWith('API key revoked.')
        })
        confirmSpy.mockRestore()
    })

    test('does not revoke when confirmation is declined', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY] })
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)

        render(<DeveloperSettings />)
        await waitFor(() => {
            expect(screen.getByText('Revoke')).toBeInTheDocument()
        })

        await userEvent.click(screen.getByText('Revoke'))

        expect(mockRevoke).not.toHaveBeenCalled()
        confirmSpy.mockRestore()
    })

    test('shows a toast when revoking fails', async () => {
        mockList.mockResolvedValue({ keys: [KEY_SUMMARY] })
        mockRevoke.mockRejectedValue(new Error('revoke failed'))
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

        render(<DeveloperSettings />)
        await waitFor(() => {
            expect(screen.getByText('Revoke')).toBeInTheDocument()
        })

        await userEvent.click(screen.getByText('Revoke'))

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('revoke failed')
        })
        confirmSpy.mockRestore()
    })

    test('shows em dash for missing last-used date', async () => {
        mockList.mockResolvedValue({
            keys: [{ ...KEY_SUMMARY, lastUsedAt: undefined }],
        })

        render(<DeveloperSettings />)

        await waitFor(() => {
            expect(screen.getByText('Last used —')).toBeInTheDocument()
        })
    })
})
