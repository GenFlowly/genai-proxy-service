import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolsSettings } from './ToolsSettings'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import {
    deleteCustomerTool,
    dryRunCustomerTool,
    getCustomerTool,
    getToolCredentialStatuses,
    listCustomerTools,
    saveCustomerTool,
} from '../../../services/customerToolsService'

jest.mock('../../../context/AuthContext')
jest.mock('../../../context/ToastContext')
// The network calls are mocked, but the pure helpers — masking above all —
// stay real: they are the thing the panel's safety rests on.
jest.mock('../../../services/customerToolsService', () => ({
    ...jest.requireActual('../../../services/customerToolsService'),
    listCustomerTools: jest.fn(),
    getCustomerTool: jest.fn(),
    saveCustomerTool: jest.fn(),
    deleteCustomerTool: jest.fn(),
    dryRunCustomerTool: jest.fn(),
    getToolCredentialStatuses: jest.fn(),
    storeToolCredentials: jest.fn(),
    deleteToolCredentials: jest.fn(),
}))
// Render library inputs/buttons as native elements so the form is inspectable
jest.mock('@genflowly/component-library', () => ({
    InputTextWithHint: ({ hint, value, onChange, placeholder, disabled }: any) => (
        <label>
            {hint}
            <input
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                disabled={disabled}
            />
        </label>
    ),
    InputSelectWithHint: ({ hint, value, onChange, options, 'data-testid': testId }: any) => (
        <select
            aria-label={hint}
            data-testid={testId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
        >
            {options.map((option: any) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
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

const mockUseAuth = useAuth as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockList = listCustomerTools as jest.Mock
const mockGet = getCustomerTool as jest.Mock
const mockSave = saveCustomerTool as jest.Mock
const mockDelete = deleteCustomerTool as jest.Mock
const mockDryRun = dryRunCustomerTool as jest.Mock
const mockCredentialStatuses = getToolCredentialStatuses as jest.Mock

const SECRET = 'sk-live-super-secret'

const CREATE_ISSUE = {
    name: 'create_issue',
    description: 'Create an issue in our tracker and return its identifier.',
    parameters: JSON.stringify({
        type: 'object',
        properties: { title: { type: 'string', description: 'Issue title' } },
        required: ['title'],
    }),
    provider: 'http',
    request: JSON.stringify({
        method: 'POST',
        url: 'https://api.example.com/v1/issues',
        headers: {
            Authorization: 'Bearer {{credential.api_key}}',
            'Content-Type': 'application/json',
        },
        query: {},
        body: { title: '{{args.title}}' },
        bodyType: 'json',
    }),
    credentialRef: 'create_issue',
    responseTransform: JSON.stringify({ mode: 'json_path', path: 'identifier', maxChars: 8000 }),
    status: 'active',
    version: 3,
    origin: 'manual',
    originRef: '',
    lastDryRunAt: '2026-03-01T10:00:00Z',
    createdAt: '2026-02-01T10:00:00Z',
    updatedAt: '2026-03-01T10:00:00Z',
}

const LOOKUP_ORDER = {
    ...CREATE_ISSUE,
    name: 'lookup_order',
    description: 'Look up an order by its number.',
    credentialRef: '',
    status: 'draft',
    lastDryRunAt: '',
}

const DRY_RUN_OK = {
    ok: true,
    request: {
        method: 'POST',
        url: 'https://api.example.com/v1/issues',
        headers: {
            // As actually sent: the resolved secret must never reach the panel
            Authorization: `Bearer ${SECRET}`,
            'Content-Type': 'application/json',
        },
        query: {},
        body: { title: 'Printer on fire' },
    },
    response: {
        status_code: 201,
        body: '{"identifier":"ISS-42","title":"Printer on fire"}',
        truncated: false,
    },
    model_sees: 'ISS-42',
}

describe('ToolsSettings', () => {
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
        mockList.mockResolvedValue({ tools: [] })
        mockCredentialStatuses.mockResolvedValue({ toolCredentialStatuses: [] })
    })

    test('renders the header and the empty state', async () => {
        render(<ToolsSettings />)

        expect(screen.getByText('Tools')).toBeInTheDocument()
        await waitFor(() => {
            expect(screen.getByText('No tools yet.')).toBeInTheDocument()
        })
        expect(mockList).toHaveBeenCalledWith('test-token')
    })

    test('lists tools with their status and whether a secret is connected', async () => {
        mockList.mockResolvedValue({ tools: [CREATE_ISSUE, LOOKUP_ORDER] })
        mockCredentialStatuses.mockResolvedValue({
            toolCredentialStatuses: [
                { toolType: 'create_issue', authType: 'api_key', connected: true },
            ],
        })

        render(<ToolsSettings />)

        await waitFor(() => {
            expect(screen.getByTestId('tool-row-create_issue')).toBeInTheDocument()
        })

        const activeRow = within(screen.getByTestId('tool-row-create_issue'))
        expect(activeRow.getByText('On')).toBeInTheDocument()
        expect(activeRow.getByText('Secret saved')).toBeInTheDocument()

        const draftRow = within(screen.getByTestId('tool-row-lookup_order'))
        expect(draftRow.getByText('Draft')).toBeInTheDocument()
        expect(draftRow.getByText('No secret')).toBeInTheDocument()
    })

    test('does not load anything when unauthenticated', () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })

        render(<ToolsSettings />)

        expect(mockList).not.toHaveBeenCalled()
    })

    test('shows a toast when the list cannot be loaded', async () => {
        mockList.mockRejectedValue(new Error('load failed'))

        render(<ToolsSettings />)

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('load failed')
        })
    })

    test('rejects a bad tool name before saving', async () => {
        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-tool')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('add-tool'))
        await userEvent.type(screen.getByPlaceholderText('e.g. create_issue'), 'Create Issue!')
        await userEvent.click(screen.getByTestId('save-tool'))

        await waitFor(() => {
            expect(screen.getByTestId('tool-name-error')).toHaveTextContent(
                'Use 3 to 64 characters: lowercase letters, numbers and underscores, starting with a letter.'
            )
        })
        expect(mockSave).not.toHaveBeenCalled()
        expect(mockShowToast).toHaveBeenCalledWith('Some fields still need fixing.')
    })

    test('rejects a name the platform already owns', async () => {
        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-tool')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('add-tool'))
        await userEvent.type(screen.getByPlaceholderText('e.g. create_issue'), 'web_search')
        await userEvent.click(screen.getByTestId('save-tool'))

        await waitFor(() => {
            expect(screen.getByTestId('tool-name-error')).toHaveTextContent('built-in tool')
        })
        expect(mockSave).not.toHaveBeenCalled()
    })

    test('masks the secret value in the dry-run panel', async () => {
        mockList.mockResolvedValue({ tools: [CREATE_ISSUE] })
        mockSave.mockResolvedValue(CREATE_ISSUE)
        mockGet.mockResolvedValue(CREATE_ISSUE)
        mockDryRun.mockResolvedValue(DRY_RUN_OK)

        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('edit-tool-create_issue')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('edit-tool-create_issue'))
        await userEvent.type(screen.getByTestId('test-value-title'), 'Printer on fire')
        await userEvent.click(screen.getByTestId('dry-run'))

        await waitFor(() => {
            expect(screen.getByTestId('dry-run-panel')).toBeInTheDocument()
        })

        // 1. the outbound request, with the credential blanked out
        const outbound = screen.getByTestId('dry-run-request')
        expect(outbound).toHaveTextContent('Bearer ••••••••')
        expect(outbound.textContent).not.toContain(SECRET)
        expect(outbound).toHaveTextContent('POST https://api.example.com/v1/issues')
        // 2. the raw response
        expect(screen.getByTestId('dry-run-response')).toHaveTextContent('"identifier":"ISS-42"')
        // 3. the exact string the model is handed
        expect(screen.getByTestId('dry-run-model-text')).toHaveTextContent('ISS-42')
        // Nothing anywhere on the page leaks the secret
        expect(document.body.textContent).not.toContain(SECRET)
    })

    test('shows the error the server returns when the dry run cannot be made', async () => {
        mockList.mockResolvedValue({ tools: [CREATE_ISSUE] })
        mockSave.mockResolvedValue(CREATE_ISSUE)
        mockDryRun.mockRejectedValue(new Error('Dry run failed: 404 Not Found'))

        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('edit-tool-create_issue')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('edit-tool-create_issue'))
        await userEvent.click(screen.getByTestId('dry-run'))

        await waitFor(() => {
            expect(screen.getByTestId('dry-run-error')).toHaveTextContent('Dry run failed: 404 Not Found')
        })
        expect(screen.queryByTestId('dry-run-panel')).not.toBeInTheDocument()
    })

    test('deletes a tool after confirmation', async () => {
        mockList.mockResolvedValue({ tools: [CREATE_ISSUE] })
        mockDelete.mockResolvedValue(undefined)
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('delete-tool-create_issue')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('delete-tool-create_issue'))

        expect(confirmSpy).toHaveBeenCalledWith(
            'Delete the tool "create_issue"? Assistants using it will stop being able to call it.'
        )
        await waitFor(() => {
            expect(mockDelete).toHaveBeenCalledWith('test-token', 'create_issue')
            expect(mockShowToast).toHaveBeenCalledWith('Tool deleted.')
        })
        confirmSpy.mockRestore()
    })

    test('does not delete when the confirmation is declined', async () => {
        mockList.mockResolvedValue({ tools: [CREATE_ISSUE] })
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)

        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('delete-tool-create_issue')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('delete-tool-create_issue'))

        expect(mockDelete).not.toHaveBeenCalled()
        confirmSpy.mockRestore()
    })

    test('shows a toast when deleting fails', async () => {
        mockList.mockResolvedValue({ tools: [CREATE_ISSUE] })
        mockDelete.mockRejectedValue(new Error('delete failed'))
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('delete-tool-create_issue')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('delete-tool-create_issue'))

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('delete failed')
        })
        confirmSpy.mockRestore()
    })

    test('a new tool cannot be turned on before a dry run has succeeded', async () => {
        render(<ToolsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-tool')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('add-tool'))

        expect(screen.getByTestId('activate-tool')).toBeDisabled()
        expect(
            screen.getByText('A tool can be turned on once a dry run has succeeded.')
        ).toBeInTheDocument()
    })
})
