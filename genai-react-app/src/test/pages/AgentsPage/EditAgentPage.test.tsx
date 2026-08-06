import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom';
import EditAgentPage from '../../../pages/AgentsPage/EditAgentPage/EditAgentPage';
import { useAuth } from '../../../context/AuthContext';
import * as agentsService from '../../../services/agentsService';

// ── Static mocks ──────────────────────────────────────────────────────────────

jest.mock('../../../components/navbar/Navbar', () => () => <div data-testid="navbar" />);

jest.mock('../../../context/AuthContext', () => ({ useAuth: jest.fn() }));

const mockSetLeftSidebarExpanded = jest.fn();
const mockSetRightSidebarExpanded = jest.fn();
jest.mock('../../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: mockSetLeftSidebarExpanded,
        setRightSidebarExpanded: mockSetRightSidebarExpanded,
    }),
}));

jest.mock('../../../hooks/usePageTitle', () => ({ usePageTitle: jest.fn() }));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../../services/agentsService', () => ({
    getCustomerAgents: jest.fn(),
    updateAgent: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockToken = 'mock-token';

const mockAgent = {
    graphId: 'graph-001',
    name: 'Default Graph',
    isDefault: true,
    entryPoint: 'node-001',
    maxIterations: 10,
    edges: '{}',
    nodes: [
        {
            nodeId: 'node-001',
            nodeType: 'QUERY_ANALYZER',
            name: 'Query Analyzer',
            config: '{\n  "system_prompt": "Analyze this query.",\n  "input_template": "{query}"\n}',
        },
        {
            nodeId: 'node-002',
            nodeType: 'RETRIEVAL',
            name: 'Retrieval',
            config: '{\n}',
        },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPage(graphId = 'graph-001') {
    return render(
        <MemoryRouter initialEntries={[`/agents/${graphId}`]}>
            <Routes>
                <Route path="/agents/:graphId" element={<EditAgentPage />} />
            </Routes>
        </MemoryRouter>
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EditAgentPage Component', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (useAuth as jest.Mock).mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue(mockToken),
        });
    });

    // ── Loading / not found ───────────────────────────────────────────────────

    test('shows loading state before agent is fetched', () => {
        (agentsService.getCustomerAgents as jest.Mock).mockReturnValue(new Promise(() => {}));
        renderPage();
        expect(screen.getByText('Loading agent…')).toBeInTheDocument();
    });

    test('shows "Agent not found" when graphId does not match any agent', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [] });
        renderPage('nonexistent-id');
        await waitFor(() => expect(screen.getByText('Agent not found.')).toBeInTheDocument());
    });

    // ── Rendering ─────────────────────────────────────────────────────────────

    test('renders navbar', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('navbar')).toBeInTheDocument());
    });

    test('renders agent name in top bar after loading', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByText('Default Graph')).toBeInTheDocument());
    });

    test('renders Back to Agents button', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /back to agents/i })).toBeInTheDocument()
        );
    });

    test('renders Agent Settings section with name and maxIterations inputs', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
        expect(screen.getByLabelText(/Max Iterations/)).toBeInTheDocument();
    });

    test('populates name input with agent name', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => {
            const input = screen.getByLabelText('Name') as HTMLInputElement;
            expect(input.value).toBe('Default Graph');
        });
    });

    test('populates maxIterations input with agent value', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => {
            const input = screen.getByLabelText(/Max Iterations/) as HTMLInputElement;
            expect(input.value).toBe('10');
        });
    });

    test('renders a collapsed accordion for each node', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));
        expect(screen.getAllByText('Retrieval').length).toBeGreaterThan(0);
    });

    // ── Navigation ────────────────────────────────────────────────────────────

    test('navigates to /agents when Back button is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /back to agents/i })).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: /back to agents/i }));
        expect(mockNavigate).toHaveBeenCalledWith('/agents');
    });

    test('navigates to /agents when Discard button is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: /discard/i }));
        expect(mockNavigate).toHaveBeenCalledWith('/agents');
    });

    // ── Node accordion ────────────────────────────────────────────────────────

    test('expands node editor when accordion header is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));

        const headerBtn = screen.getAllByText('Query Analyzer')[0].closest('button')!;
        await userEvent.click(headerBtn);
        await waitFor(() => expect(screen.getByLabelText('System Prompt')).toBeInTheDocument());
    });

    test('shows system prompt field for LLM node', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));

        const headerBtn = screen.getAllByText('Query Analyzer')[0].closest('button')!;
        await userEvent.click(headerBtn);
        await waitFor(() => {
            const textarea = screen.getByLabelText('System Prompt') as HTMLTextAreaElement;
            expect(textarea.value).toBe('Analyze this query.');
        });
    });

    test('does NOT show system prompt for RETRIEVAL node', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getAllByText('Retrieval').length).toBeGreaterThan(0));

        const headerBtn = screen.getAllByText('Retrieval')[0].closest('button')!;
        await userEvent.click(headerBtn);
        // System Prompt label only appears in one node (the LLM one), not for RETRIEVAL
        expect(screen.queryByLabelText('System Prompt')).not.toBeInTheDocument();
    });

    // ── Client-side validation ────────────────────────────────────────────────

    test('shows error when name is cleared and Save is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        expect(screen.getByText('Agent name must not be blank.')).toBeInTheDocument();
        expect(agentsService.updateAgent).not.toHaveBeenCalled();
    });

    test('shows error when maxIterations is out of range', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByLabelText(/Max Iterations/)).toBeInTheDocument());

        const iterInput = screen.getByLabelText(/Max Iterations/) as HTMLInputElement;
        await userEvent.clear(iterInput);
        await userEvent.type(iterInput, '200');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        expect(screen.getByText('Max iterations must be between 1 and 100.')).toBeInTheDocument();
        expect(agentsService.updateAgent).not.toHaveBeenCalled();
    });

    // ── Save ──────────────────────────────────────────────────────────────────

    test('calls updateAgent with changed name on save', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        (agentsService.updateAgent as jest.Mock).mockResolvedValueOnce({
            ...mockAgent,
            name: 'Renamed Agent',
        });

        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Renamed Agent');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() =>
            expect(agentsService.updateAgent).toHaveBeenCalledWith(
                mockToken,
                'graph-001',
                expect.objectContaining({ name: 'Renamed Agent' })
            )
        );
    });

    test('shows "Saved" badge on successful save', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        (agentsService.updateAgent as jest.Mock).mockResolvedValueOnce({
            ...mockAgent,
            name: 'Updated Name',
        });

        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Updated Name');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(screen.getByText(/✓ Saved/)).toBeInTheDocument());
    });

    test('shows server error message when updateAgent throws', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        (agentsService.updateAgent as jest.Mock).mockRejectedValueOnce(
            new Error('entryPoint nodeId not in graph')
        );

        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'New Name');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() =>
            expect(screen.getByText('entryPoint nodeId not in graph')).toBeInTheDocument()
        );
    });

    test('navigates to /agents when Discard button is clicked instead of save with no diff', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument());

        await userEvent.click(screen.getByRole('button', { name: /discard/i }));

        expect(mockNavigate).toHaveBeenCalledWith('/agents');
    });

    test('edits node name, input template, and model override', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        (agentsService.updateAgent as jest.Mock).mockResolvedValueOnce({ ...mockAgent });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));

        const headerBtn = screen.getAllByText('Query Analyzer')[0].closest('button')!;
        await userEvent.click(headerBtn);
        await waitFor(() => expect(screen.getByPlaceholderText('Query Analyzer')).toBeInTheDocument());

        const nodeNameInput = screen.getByPlaceholderText('Query Analyzer') as HTMLInputElement;
        await userEvent.clear(nodeNameInput);
        await userEvent.type(nodeNameInput, 'New Node Name');

        const inputTemplateTextarea = screen.getByPlaceholderText('{query}') as HTMLTextAreaElement;
        await userEvent.clear(inputTemplateTextarea);
        await userEvent.type(inputTemplateTextarea, '{query} with extra context');

        const modelOverrideInput = screen.getByPlaceholderText('e.g. gpt-4o, claude-sonnet-4-5') as HTMLInputElement;
        await userEvent.type(modelOverrideInput, 'gpt-4o');

        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() =>
            expect(agentsService.updateAgent).toHaveBeenCalledWith(
                mockToken,
                'graph-001',
                expect.objectContaining({
                    nodes: expect.arrayContaining([
                        expect.objectContaining({
                            nodeId: 'node-001',
                            name: 'New Node Name',
                        }),
                    ]),
                })
            )
        );
    });

    test('shows invalid JSON indicator when editing raw config with bad JSON', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        const { container } = renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));

        const headerBtn = screen.getAllByText('Query Analyzer')[0].closest('button')!;
        await userEvent.click(headerBtn);
        await waitFor(() => expect(container.querySelector('#raw-config-node-001')).toBeInTheDocument());

        const rawJsonArea = container.querySelector('#raw-config-node-001') as HTMLTextAreaElement;
        await userEvent.clear(rawJsonArea);
        await userEvent.type(rawJsonArea, 'invalid_json');

        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(screen.getByText(/Node "Query Analyzer" has invalid JSON config./)).toBeInTheDocument());
        expect(agentsService.updateAgent).not.toHaveBeenCalled();
    });

    test('handles unknown node type with fallback node meta', async () => {
        const unknownAgent = {
            ...mockAgent,
            nodes: [
                {
                    nodeId: 'node-unknown',
                    nodeType: 'CUSTOM_NODE_TYPE',
                    name: 'Custom Node',
                    config: '{}',
                },
            ],
        };
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [unknownAgent] });
        renderPage();

        await waitFor(() => expect(screen.getByText('Custom Node')).toBeInTheDocument());
        expect(screen.getByText('CUSTOM_NODE_TYPE')).toBeInTheDocument();
    });

    test('handles getCustomerAgents error without message property', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockRejectedValueOnce({});
        renderPage();

        await waitFor(() => expect(screen.getByText('Failed to load agent')).toBeInTheDocument());
    });

    test('handles updateAgent error without message property', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [mockAgent] });
        (agentsService.updateAgent as jest.Mock).mockRejectedValueOnce({});

        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Brand New Agent Name');

        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(screen.getByText('Failed to save agent')).toBeInTheDocument());
    });
});
