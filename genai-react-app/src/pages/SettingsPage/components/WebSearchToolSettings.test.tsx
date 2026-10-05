import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WebSearchToolSettings } from './WebSearchToolSettings'
import { deleteToolCredentials, storeToolCredentials } from '../../../services/customerToolsService'

jest.mock('../../../services/customerToolsService', () => ({
    storeToolCredentials: jest.fn(),
    deleteToolCredentials: jest.fn(),
}))
// Render library inputs/buttons/cards as native elements so the form is inspectable
jest.mock('@genflowly/component-library', () => ({
    InputTextWithHint: ({ hint, value, onChange, placeholder, disabled }: any) => (
        <label>
            {hint}
            <input value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
        </label>
    ),
    PillButton: ({ onClick, label, disabled, 'data-testid': testId }: any) => (
        <button onClick={onClick} disabled={disabled} data-testid={testId}>
            {label}
        </button>
    ),
    CredentialCard: ({ label, pills, message, children, 'data-testid': testId }: any) => (
        <div data-testid={testId}>
            <span>{label}</span>
            {pills}
            {children}
            {message && <span>{message}</span>}
        </div>
    ),
    CredentialStatusPill: ({ children, 'data-testid': testId }: any) => (
        <span data-testid={testId}>{children}</span>
    ),
}))

const mockStore = storeToolCredentials as jest.Mock
const mockDelete = deleteToolCredentials as jest.Mock

describe('WebSearchToolSettings', () => {
    const mockGetAccessTokenSilently = jest.fn()
    const mockOnChanged = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAccessTokenSilently.mockResolvedValue('test-token')
    })

    test('shows "Not set" and no remove button when no key is stored', () => {
        render(
            <WebSearchToolSettings
                connected={false}
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        expect(screen.getByText('Not set')).toBeInTheDocument()
        expect(screen.queryByTestId('web-search-credential-remove')).not.toBeInTheDocument()
    })

    test('shows "Key set" and a remove button when a key is stored', () => {
        render(
            <WebSearchToolSettings
                connected
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        expect(screen.getByText('Key set')).toBeInTheDocument()
        expect(screen.getByTestId('web-search-credential-remove')).toBeInTheDocument()
    })

    test('saves the key under toolType WEB_SEARCH with authType api_key', async () => {
        mockStore.mockResolvedValue({ toolCredentialStatus: { toolType: 'WEB_SEARCH', authType: 'api_key', connected: true } })
        render(
            <WebSearchToolSettings
                connected={false}
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        await userEvent.type(screen.getByRole('textbox'), 'tvly-secret-key')
        await userEvent.click(screen.getByTestId('web-search-credential-save'))

        await waitFor(() => {
            expect(mockStore).toHaveBeenCalledWith('test-token', {
                toolType: 'WEB_SEARCH',
                authType: 'api_key',
                credentials: { api_key: 'tvly-secret-key' },
            })
        })
        expect(screen.getByText('Key saved.')).toBeInTheDocument()
        expect(mockOnChanged).toHaveBeenCalled()
    })

    test('does not save an empty key', () => {
        render(
            <WebSearchToolSettings
                connected={false}
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        // The save button stays disabled with no input, matching VendorApiKeysManager
        expect(screen.getByTestId('web-search-credential-save')).toBeDisabled()
        expect(mockStore).not.toHaveBeenCalled()
    })

    test('removes the key after confirmation', async () => {
        mockDelete.mockResolvedValue(undefined)
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)
        render(
            <WebSearchToolSettings
                connected
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        await userEvent.click(screen.getByTestId('web-search-credential-remove'))

        await waitFor(() => {
            expect(mockDelete).toHaveBeenCalledWith('test-token', 'WEB_SEARCH')
        })
        expect(screen.getByText('Key removed.')).toBeInTheDocument()
        expect(mockOnChanged).toHaveBeenCalled()
        confirmSpy.mockRestore()
    })

    test('does not remove when the confirmation is declined', async () => {
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)
        render(
            <WebSearchToolSettings
                connected
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        await userEvent.click(screen.getByTestId('web-search-credential-remove'))

        expect(mockDelete).not.toHaveBeenCalled()
        confirmSpy.mockRestore()
    })

    test('shows the server error message when saving fails', async () => {
        mockStore.mockRejectedValue(new Error('KMS unavailable'))
        render(
            <WebSearchToolSettings
                connected={false}
                getAccessTokenSilently={mockGetAccessTokenSilently}
                onChanged={mockOnChanged}
            />
        )

        await userEvent.type(screen.getByRole('textbox'), 'tvly-secret-key')
        await userEvent.click(screen.getByTestId('web-search-credential-save'))

        await waitFor(() => {
            expect(screen.getByText('KMS unavailable')).toBeInTheDocument()
        })
        expect(mockOnChanged).not.toHaveBeenCalled()
    })
})
