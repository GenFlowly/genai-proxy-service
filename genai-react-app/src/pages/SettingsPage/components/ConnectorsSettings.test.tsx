import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectorsSettings } from './ConnectorsSettings'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { storeToolCredentials } from '../../../services/customerToolsService'
import {
    connectMcpConnector,
    disconnectConnector,
    discoverMcpConnector,
    importSpecConnector,
    listConnectors,
    previewSpecConnector,
} from '../../../services/connectorsService'

jest.mock('../../../context/AuthContext')
jest.mock('../../../context/ToastContext')
jest.mock('../../../services/customerToolsService', () => ({
    ...jest.requireActual('../../../services/customerToolsService'),
    storeToolCredentials: jest.fn(),
}))
// The network calls are mocked; the pure helpers stay real, because the key
// names a credential is filed under are derived by them.
jest.mock('../../../services/connectorsService', () => ({
    ...jest.requireActual('../../../services/connectorsService'),
    listConnectors: jest.fn(),
    previewSpecConnector: jest.fn(),
    importSpecConnector: jest.fn(),
    discoverMcpConnector: jest.fn(),
    connectMcpConnector: jest.fn(),
    disconnectConnector: jest.fn(),
}))
// Render library inputs/buttons as native elements so the flow is inspectable
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
    PillButton: ({ onClick, label, disabled, 'data-testid': testId }: any) => (
        <button onClick={onClick} disabled={disabled} data-testid={testId}>
            {label}
        </button>
    ),
}))

const mockUseAuth = useAuth as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockList = listConnectors as jest.Mock
const mockPreview = previewSpecConnector as jest.Mock
const mockImport = importSpecConnector as jest.Mock
const mockDiscover = discoverMcpConnector as jest.Mock
const mockConnect = connectMcpConnector as jest.Mock
const mockDisconnect = disconnectConnector as jest.Mock
const mockStoreCredentials = storeToolCredentials as jest.Mock

const SECRET = 'sk-live-super-secret'

const SPEC_URL = 'https://api.example.com/openapi.json'
const SERVER_URL = 'https://mcp.notion.com/mcp'

const EXAMPLE_CONNECTOR = {
    id: 'api-example-com-openapi-json',
    kind: 'openapi',
    label: 'Example API',
    ref: SPEC_URL,
    toolCount: 3,
    credentialRef: 'EXAMPLE',
    connectedAt: '2026-03-01T10:00:00Z',
}

const NOTION_CONNECTOR = {
    id: 'notion',
    kind: 'mcp',
    label: 'Notion',
    ref: SERVER_URL,
    toolCount: 7,
    credentialRef: 'NOTION',
    connectedAt: '2026-03-02T10:00:00Z',
}

/** One ready-to-save operation, as the preview hands them over. */
const operation = (index: number) => ({
    name: `list_issues_${index}`,
    description: `List the issues in project ${index}.`,
    method: 'GET',
    path: `/v1/projects/${index}/issues`,
    parameters: { type: 'object', properties: {}, required: [] },
    request: {
        method: 'GET',
        url: `https://api.example.com/v1/projects/${index}/issues`,
        headers: { Authorization: 'Bearer {{credential.api_key}}' },
        query: {},
        body: null,
        bodyType: 'json',
    },
    responseTransform: { mode: 'json', maxChars: 8000 },
})

const previewOf = (count: number) => ({
    ok: true,
    title: 'Example API',
    server_url: 'https://api.example.com',
    operations: Array.from({ length: count }, (_, index) => operation(index)),
    skipped: [
        { operationId: 'uploadAttachment', reason: 'Sends a file, which a tool cannot describe.' },
        { operationId: 'streamEvents', reason: 'Streams its response.' },
    ],
    error: null,
})

const DISCOVERY = {
    ok: true,
    server_name: 'Notion',
    tool_count: 3,
    tools: [
        { name: 'search', description: 'Search the workspace.', inputSchema: {} },
        { name: 'fetch_page', description: 'Read one page.', inputSchema: {} },
        { name: 'create_page', description: 'Create a page in a database.', inputSchema: {} },
    ],
    error: null,
}

const openSpecFlow = async () => {
    await userEvent.click(screen.getByTestId('add-connector'))
    await userEvent.click(screen.getByTestId('choose-api-spec'))
}

const openServerFlow = async () => {
    await userEvent.click(screen.getByTestId('add-connector'))
    await userEvent.click(screen.getByTestId('choose-mcp-server'))
}

describe('ConnectorsSettings', () => {
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
        mockList.mockResolvedValue({ connectors: [] })
        mockStoreCredentials.mockResolvedValue({})
    })

    test('renders the empty state', async () => {
        render(<ConnectorsSettings />)

        await waitFor(() => {
            expect(screen.getByText('Nothing connected yet.')).toBeInTheDocument()
        })
        expect(mockList).toHaveBeenCalledWith('test-token')
    })

    test('lists what is connected with its kind and how many tools it brought', async () => {
        mockList.mockResolvedValue({ connectors: [EXAMPLE_CONNECTOR, NOTION_CONNECTOR] })

        render(<ConnectorsSettings />)

        await waitFor(() => {
            expect(screen.getByTestId('connector-row-notion')).toBeInTheDocument()
        })

        const serverRow = within(screen.getByTestId('connector-row-notion'))
        expect(serverRow.getByText('Notion')).toBeInTheDocument()
        expect(serverRow.getByText('MCP server')).toBeInTheDocument()
        expect(serverRow.getByText('7 tools')).toBeInTheDocument()

        const specRow = within(screen.getByTestId('connector-row-api-example-com-openapi-json'))
        expect(specRow.getByText('Example API')).toBeInTheDocument()
        expect(specRow.getByText('API')).toBeInTheDocument()
        expect(specRow.getByText('3 tools')).toBeInTheDocument()
    })

    test('does not load anything when unauthenticated', () => {
        mockUseAuth.mockReturnValue({
            customerId: null,
            isAuthenticated: false,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        })

        render(<ConnectorsSettings />)

        expect(mockList).not.toHaveBeenCalled()
    })

    test('shows a toast when the list cannot be loaded', async () => {
        mockList.mockRejectedValue(new Error('load failed'))

        render(<ConnectorsSettings />)

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('load failed')
        })
    })

    test('previews a spec without creating anything, then imports only what was ticked', async () => {
        mockPreview.mockResolvedValue(previewOf(2))
        mockImport.mockResolvedValue({
            connector: EXAMPLE_CONNECTOR,
            tools: [{ name: 'list_issues_1' }],
        })

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-connector')).toBeInTheDocument())

        await openSpecFlow()
        await userEvent.type(screen.getByPlaceholderText('https://api.example.com/openapi.json'), SPEC_URL)
        await userEvent.type(screen.getByTestId('connector-key'), SECRET)
        await userEvent.click(screen.getByTestId('preview-spec'))

        await waitFor(() => expect(screen.getByTestId('spec-preview')).toBeInTheDocument())

        // Every operation, with its method, path and summary
        const firstOperation = within(screen.getByTestId('operation-list_issues_0'))
        expect(firstOperation.getByText('GET')).toBeInTheDocument()
        expect(firstOperation.getByText('/v1/projects/0/issues')).toBeInTheDocument()
        expect(firstOperation.getByText('List the issues in project 0.')).toBeInTheDocument()
        // And what could not be brought in, with the reason
        const skipped = within(screen.getByTestId('skipped-operations'))
        expect(skipped.getByText('2 operations could not be brought in')).toBeInTheDocument()
        expect(skipped.getByText('Sends a file, which a tool cannot describe.')).toBeInTheDocument()
        // The first step writes nothing at all
        expect(mockImport).not.toHaveBeenCalled()
        expect(mockStoreCredentials).not.toHaveBeenCalled()
        // And the address it was read from never leaves with the key attached
        expect(JSON.stringify(mockPreview.mock.calls[0][1])).not.toContain(SECRET)

        await userEvent.click(screen.getByTestId('operation-checkbox-list_issues_1'))
        expect(screen.getByTestId('selection-count')).toHaveTextContent('1 of 20 selected')
        await userEvent.click(screen.getByTestId('import-spec'))

        await waitFor(() => expect(mockImport).toHaveBeenCalled())
        // The key is filed under the name the chosen calls actually look for
        expect(mockStoreCredentials).toHaveBeenCalledWith('test-token', {
            toolType: 'EXAMPLE',
            authType: 'api_key',
            credentials: { api_key: SECRET },
        })
        const importPayload = mockImport.mock.calls[0][1]
        expect(importPayload.specUrl).toBe(SPEC_URL)
        expect(importPayload.credentialRef).toBe('EXAMPLE')
        expect(importPayload.operations).toHaveLength(1)
        expect(importPayload.operations[0].name).toBe('list_issues_1')
        expect(JSON.stringify(importPayload)).not.toContain(SECRET)

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('1 tool imported as a draft.')
        })
        expect(screen.getByTestId('open-tools')).toHaveAttribute('href', '/settings/tools')
        expect(document.body.textContent).not.toContain(SECRET)
    })

    test('lets at most twenty operations be picked, and says so', async () => {
        mockPreview.mockResolvedValue(previewOf(25))

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-connector')).toBeInTheDocument())

        await openSpecFlow()
        await userEvent.type(screen.getByPlaceholderText('https://api.example.com/openapi.json'), SPEC_URL)
        await userEvent.click(screen.getByTestId('preview-spec'))

        await waitFor(() => expect(screen.getByTestId('spec-preview')).toBeInTheDocument())
        expect(
            screen.getByText(/Pick up to 20\./)
        ).toBeInTheDocument()

        for (let index = 0; index < 20; index++) {
            await userEvent.click(screen.getByTestId(`operation-checkbox-list_issues_${index}`))
        }

        expect(screen.getByTestId('selection-count')).toHaveTextContent('20 of 20 selected')
        expect(screen.getByTestId('selection-full')).toHaveTextContent(
            'That is as many as one import can bring in. Untick one to pick another.'
        )
        // The twenty-first cannot be ticked while twenty are
        expect(screen.getByTestId('operation-checkbox-list_issues_20')).toBeDisabled()
        expect(screen.getByTestId('operation-checkbox-list_issues_0')).not.toBeDisabled()
    })

    test('shows the error the server returns when a spec cannot be read', async () => {
        mockPreview.mockRejectedValue(new Error('Preview failed: 502 Bad Gateway'))

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-connector')).toBeInTheDocument())

        await openSpecFlow()
        await userEvent.type(screen.getByPlaceholderText('https://api.example.com/openapi.json'), SPEC_URL)
        await userEvent.click(screen.getByTestId('preview-spec'))

        await waitFor(() => {
            expect(screen.getByTestId('preview-error')).toHaveTextContent('Preview failed: 502 Bad Gateway')
        })
        expect(screen.queryByTestId('spec-preview')).not.toBeInTheDocument()
    })

    test('asks a server what it offers, then connects exactly the approved list', async () => {
        mockDiscover.mockResolvedValue(DISCOVERY)
        mockConnect.mockResolvedValue({ connector: NOTION_CONNECTOR, tool: { name: 'notion' } })

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-connector')).toBeInTheDocument())

        await openServerFlow()
        await userEvent.type(screen.getByPlaceholderText('https://mcp.example.com/mcp'), SERVER_URL)
        await userEvent.type(screen.getByTestId('connector-key'), SECRET)
        await userEvent.click(screen.getByTestId('discover-mcp'))

        await waitFor(() => expect(screen.getByTestId('mcp-approval')).toBeInTheDocument())

        // The key went to the credential store, and the request names it rather
        // than carrying it
        expect(mockStoreCredentials).toHaveBeenCalledWith('test-token', {
            toolType: 'NOTION',
            authType: 'api_key',
            credentials: { token: SECRET },
        })
        expect(mockDiscover).toHaveBeenCalledWith('test-token', {
            serverUrl: SERVER_URL,
            credentialRef: 'NOTION',
            headers: { Authorization: 'Bearer {{credential.token}}' },
        })

        // What is being approved, and what approving means
        expect(
            screen.getByText('Approve what your assistants will be told about')
        ).toBeInTheDocument()
        expect(screen.getByTestId('mcp-approval')).toHaveTextContent(
            'Notion offers 3 tools. If you approve, your assistants are told about every one of them'
        )
        expect(screen.getByTestId('approval-pinned')).toHaveTextContent(
            'the new one has to be approved on this page before they are told about it'
        )
        const tool = within(screen.getByTestId('discovered-tool-search'))
        expect(tool.getByText('search')).toBeInTheDocument()
        expect(tool.getByText('Search the workspace.')).toBeInTheDocument()
        // Nothing has been written by the asking
        expect(mockConnect).not.toHaveBeenCalled()

        await userEvent.click(screen.getByTestId('approve-mcp'))

        await waitFor(() => expect(mockConnect).toHaveBeenCalled())
        const connectPayload = mockConnect.mock.calls[0][1]
        expect(connectPayload.serverUrl).toBe(SERVER_URL)
        expect(connectPayload.credentialRef).toBe('NOTION')
        expect(connectPayload.label).toBe('Notion')
        expect(connectPayload.tools).toEqual(DISCOVERY.tools)
        expect(JSON.stringify(connectPayload)).not.toContain(SECRET)

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('Connected. 3 tools approved.')
        })
        expect(screen.queryByTestId('mcp-connector-form')).not.toBeInTheDocument()
        expect(document.body.textContent).not.toContain(SECRET)
    })

    test('shows the error a server reports instead of an approval list', async () => {
        mockDiscover.mockResolvedValue({
            ok: false,
            server_name: '',
            tool_count: 0,
            tools: [],
            error: 'The server refused the connection.',
        })

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-connector')).toBeInTheDocument())

        await openServerFlow()
        await userEvent.type(screen.getByPlaceholderText('https://mcp.example.com/mcp'), SERVER_URL)
        await userEvent.click(screen.getByTestId('discover-mcp'))

        await waitFor(() => {
            expect(screen.getByTestId('discover-error')).toHaveTextContent('The server refused the connection.')
        })
        expect(screen.queryByTestId('mcp-approval')).not.toBeInTheDocument()
    })

    test('refuses an address that is not https before anything leaves the browser', async () => {
        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('add-connector')).toBeInTheDocument())

        await openSpecFlow()
        await userEvent.type(
            screen.getByPlaceholderText('https://api.example.com/openapi.json'),
            'http://api.example.com/openapi.json'
        )
        await userEvent.click(screen.getByTestId('preview-spec'))

        await waitFor(() => {
            expect(screen.getByTestId('connector-url-error')).toHaveTextContent(
                'The address has to start with https://.'
            )
        })
        expect(mockPreview).not.toHaveBeenCalled()
    })

    test('says how many tools a disconnect will remove, and removes them', async () => {
        mockList.mockResolvedValue({ connectors: [NOTION_CONNECTOR] })
        mockDisconnect.mockResolvedValue(undefined)
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('disconnect-connector-notion')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('disconnect-connector-notion'))

        expect(confirmSpy).toHaveBeenCalledWith(
            'Disconnect "Notion"? This deletes all 7 tools it added, and assistants using them will stop being able to call them.'
        )
        await waitFor(() => {
            expect(mockDisconnect).toHaveBeenCalledWith('test-token', 'notion')
            expect(mockShowToast).toHaveBeenCalledWith('Disconnected.')
        })
        confirmSpy.mockRestore()
    })

    test('does not disconnect when the confirmation is declined', async () => {
        mockList.mockResolvedValue({ connectors: [NOTION_CONNECTOR] })
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false)

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('disconnect-connector-notion')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('disconnect-connector-notion'))

        expect(mockDisconnect).not.toHaveBeenCalled()
        confirmSpy.mockRestore()
    })

    test('shows a toast when disconnecting fails', async () => {
        mockList.mockResolvedValue({ connectors: [NOTION_CONNECTOR] })
        mockDisconnect.mockRejectedValue(new Error('disconnect failed'))
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

        render(<ConnectorsSettings />)
        await waitFor(() => expect(screen.getByTestId('disconnect-connector-notion')).toBeInTheDocument())

        await userEvent.click(screen.getByTestId('disconnect-connector-notion'))

        await waitFor(() => {
            expect(mockShowToast).toHaveBeenCalledWith('disconnect failed')
        })
        confirmSpy.mockRestore()
    })
})
