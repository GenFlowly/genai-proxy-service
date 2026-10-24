import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom';
import EditAgentPage from '../../../pages/AgentsPage/EditAgentPage/EditAgentPage';
import { useAuth } from '../../../context/AuthContext';
import * as agentsService from '../../../services/agentsService';
import * as instructionService from '../../../services/instructionService';

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
    getAgent: jest.fn(),
    updateAgent: jest.fn(),
    forkAgent: jest.fn(),
}));

jest.mock('../../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn(),
    createInstruction: jest.fn(),
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
        {
            nodeId: 'node-003',
            nodeType: 'QUERY_REWRITER',
            name: 'Query Rewriter',
            config: '{\n  "instruction_id": "inst-1"\n}',
            instructionName: 'Analyzer Prompt',
        },
        {
            nodeId: 'node-004',
            nodeType: 'RESULT_RANKER',
            name: 'Result Ranker',
            config: '{}',
        },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
};

const mockInstructions = [
    { id: 'inst-1', name: 'Analyzer Prompt', version: 2, instruction: 'Old analyzer text' },
    { id: 'inst-1', name: 'Analyzer Prompt', version: 3, instruction: 'Analyzer text' },
    { id: 'inst-2', name: 'Rewriter Prompt', version: 1, instruction: 'Rewriter text' },
];

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

async function expandNode(nodeName: string) {
    await waitFor(() => expect(screen.getAllByText(nodeName).length).toBeGreaterThan(0));
    const headerBtn = screen.getAllByText(nodeName)[0].closest('button')!;
    await userEvent.click(headerBtn);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EditAgentPage Component', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (useAuth as jest.Mock).mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue(mockToken),
        });
        (instructionService.getCustomerInstructions as jest.Mock).mockResolvedValue({
            instructions: mockInstructions,
        });
    });

    // ── Loading / not found ───────────────────────────────────────────────────

    test('shows loading state before agent is fetched', () => {
        (agentsService.getAgent as jest.Mock).mockReturnValue(new Promise(() => {}));
        renderPage();
        expect(screen.getByText('Loading agent…')).toBeInTheDocument();
    });

    test('loads the agent through the dedicated getAgent endpoint', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() =>
            expect(agentsService.getAgent).toHaveBeenCalledWith(mockToken, 'graph-001')
        );
    });

    test('shows the load error when getAgent fails', async () => {
        (agentsService.getAgent as jest.Mock).mockRejectedValueOnce(
            new Error('Get Agent failed: 404 Not Found')
        );
        renderPage('nonexistent-id');
        await waitFor(() =>
            expect(screen.getByText('Get Agent failed: 404 Not Found')).toBeInTheDocument()
        );
    });

    // ── Rendering ─────────────────────────────────────────────────────────────

    test('renders navbar', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByTestId('navbar')).toBeInTheDocument());
    });

    test('renders agent name in top bar after loading', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByText('Default Graph')).toBeInTheDocument());
    });

    test('renders Back to Agents button', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /back to agents/i })).toBeInTheDocument()
        );
    });

    test('renders Agent Settings section with name and maxIterations inputs', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
        expect(screen.getByLabelText(/Max Iterations/)).toBeInTheDocument();
    });

    test('populates name input with agent name', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => {
            const input = screen.getByLabelText('Name') as HTMLInputElement;
            expect(input.value).toBe('Default Graph');
        });
    });

    test('populates maxIterations input with agent value', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => {
            const input = screen.getByLabelText(/Max Iterations/) as HTMLInputElement;
            expect(input.value).toBe('10');
        });
    });

    test('renders a collapsed accordion for each node', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));
        expect(screen.getAllByText('Retrieval').length).toBeGreaterThan(0);
    });

    // ── Navigation ────────────────────────────────────────────────────────────

    test('navigates to /agents when Back button is clicked', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /back to agents/i })).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: /back to agents/i }));
        expect(mockNavigate).toHaveBeenCalledWith('/agents');
    });

    test('navigates to /agents when Discard button is clicked', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: /discard/i }));
        expect(mockNavigate).toHaveBeenCalledWith('/agents');
    });

    // ── Instruction selector ──────────────────────────────────────────────────

    test('shows read-only legacy prompt with Convert button for node with inline system_prompt', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await expandNode('Query Analyzer');

        const legacyTextarea = screen.getByTestId('legacy-prompt-node-001') as HTMLTextAreaElement;
        expect(legacyTextarea.value).toBe('Analyze this query.');
        expect(legacyTextarea).toHaveAttribute('readonly');
        expect(screen.getByRole('button', { name: 'Convert to instruction' })).toBeInTheDocument();
    });

    test('converts a legacy prompt into a new instruction and rewrites the config', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (instructionService.createInstruction as jest.Mock).mockResolvedValueOnce({
            id: 'inst-new',
            name: 'Default Graph — Query Analyzer',
            version: 1,
            instruction: 'Analyze this query.',
        });

        const { container } = renderPage();
        await expandNode('Query Analyzer');

        await userEvent.click(screen.getByRole('button', { name: 'Convert to instruction' }));

        await waitFor(() =>
            expect(instructionService.createInstruction).toHaveBeenCalledWith(mockToken, {
                instruction: 'Analyze this query.',
                instructionName: 'Default Graph — Query Analyzer',
            })
        );

        // Config JSON now references the new instruction and dropped system_prompt
        const rawJsonArea = container.querySelector('#raw-config-node-001') as HTMLTextAreaElement;
        await waitFor(() => expect(rawJsonArea.value).toContain('"instruction_id": "inst-new"'));
        expect(rawJsonArea.value).not.toContain('system_prompt');
        expect(rawJsonArea.value).toContain('"input_template": "{query}"');
        // Selected instruction name is displayed
        expect(screen.getByTestId('instruction-selected-node-001')).toHaveTextContent('Default Graph — Query Analyzer');
    });

    test('shows an error when converting the legacy prompt fails', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (instructionService.createInstruction as jest.Mock).mockRejectedValueOnce(new Error('Create Instruction failed: 500'));

        renderPage();
        await expandNode('Query Analyzer');

        await userEvent.click(screen.getByRole('button', { name: 'Convert to instruction' }));
        await waitFor(() => expect(screen.getByText('Create Instruction failed: 500')).toBeInTheDocument());
    });

    test('shows the selected instruction name for a node that already references one', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await expandNode('Query Rewriter');

        expect(screen.getByTestId('instruction-selected-node-003')).toHaveTextContent('Analyzer Prompt');
        expect(screen.getByLabelText('Follow latest')).toBeChecked();
    });

    test('falls back to the API-provided instructionName when the instruction is not in the list', async () => {
        const agentWithUnknownInstruction = {
            ...mockAgent,
            nodes: [
                {
                    nodeId: 'node-x',
                    nodeType: 'QUERY_REWRITER',
                    name: 'Unknown Ref',
                    config: '{"instruction_id": "inst-unknown"}',
                    instructionName: 'Server Provided Name',
                },
            ],
        };
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(agentWithUnknownInstruction);
        renderPage();
        await expandNode('Unknown Ref');

        expect(screen.getByTestId('instruction-selected-node-x')).toHaveTextContent('Server Provided Name');
    });

    test('pins the instruction to the latest version and can go back to follow latest', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        const { container } = renderPage();
        await expandNode('Query Rewriter');

        const rawJsonArea = container.querySelector('#raw-config-node-003') as HTMLTextAreaElement;

        // Pinning requires the instruction list (for the latest version number)
        await waitFor(() => expect(screen.getByLabelText('Pin to version')).toBeEnabled());
        await userEvent.click(screen.getByLabelText('Pin to version'));
        await waitFor(() => expect(rawJsonArea.value).toContain('"instruction_version": 3'));
        expect(screen.getByLabelText(/Pinned to v3/)).toBeChecked();

        await userEvent.click(screen.getByLabelText('Follow latest'));
        await waitFor(() => expect(rawJsonArea.value).not.toContain('instruction_version'));
        expect(rawJsonArea.value).toContain('"instruction_id": "inst-1"');
    });

    test('selects an instruction from the searchable dropdown for a node without one', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (agentsService.updateAgent as jest.Mock).mockResolvedValueOnce({ ...mockAgent });
        const { container } = renderPage();
        await expandNode('Result Ranker');

        const search = screen.getByTestId('instruction-search-node-004');
        await userEvent.type(search, 'Rewriter');
        await waitFor(() =>
            expect(screen.getByTestId('instruction-option-node-004-inst-2')).toBeInTheDocument()
        );
        // Non-matching instructions are filtered out
        expect(screen.queryByTestId('instruction-option-node-004-inst-1')).not.toBeInTheDocument();

        await userEvent.click(screen.getByTestId('instruction-option-node-004-inst-2'));

        const rawJsonArea = container.querySelector('#raw-config-node-004') as HTMLTextAreaElement;
        expect(rawJsonArea.value).toContain('"instruction_id": "inst-2"');

        // Saving sends the rewritten config for the node
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
        await waitFor(() =>
            expect(agentsService.updateAgent).toHaveBeenCalledWith(
                mockToken,
                'graph-001',
                expect.objectContaining({
                    nodes: expect.arrayContaining([
                        expect.objectContaining({
                            nodeId: 'node-004',
                            config: expect.stringContaining('"instruction_id": "inst-2"'),
                        }),
                    ]),
                })
            )
        );
    });

    test('does NOT show instruction controls for RETRIEVAL node', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await expandNode('Retrieval');

        expect(screen.queryByTestId('instruction-search-node-002')).not.toBeInTheDocument();
        expect(screen.queryByTestId('legacy-prompt-node-002')).not.toBeInTheDocument();
    });

    test('does NOT show instruction controls for response generator nodes', async () => {
        const responseAgent = {
            ...mockAgent,
            nodes: [
                {
                    nodeId: 'node-resp',
                    nodeType: 'RESPONSE_GENERATOR',
                    name: 'Response Generator',
                    config: '{}',
                },
            ],
        };
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(responseAgent);
        renderPage();
        await expandNode('Response Generator');

        expect(screen.queryByTestId('instruction-search-node-resp')).not.toBeInTheDocument();
        expect(
            screen.getByText('The system prompt and model for this node come from the instruction and model selected at request time.')
        ).toBeInTheDocument();
    });

    // ── System default agent ──────────────────────────────────────────────────

    test('renders a system agent read-only with the fork banner and no Save button', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce({ ...mockAgent, isSystem: true });
        renderPage();
        await waitFor(() =>
            expect(
                screen.getByText('This is a shared system agent — it is read-only. Fork it to make an editable copy.')
            ).toBeInTheDocument()
        );
        expect(screen.getByText('System')).toBeInTheDocument();
        expect(screen.getByTestId('edit-agent-fork')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
        // The whole form is disabled via the wrapping fieldset
        expect(screen.getByLabelText('Name')).toBeDisabled();
    });

    test('does not show the system banner for a customer-owned agent', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByText('Default Graph')).toBeInTheDocument());
        expect(
            screen.queryByText('This is a shared system agent — it is read-only. Fork it to make an editable copy.')
        ).not.toBeInTheDocument();
        expect(screen.getByLabelText('Name')).toBeEnabled();
    });

    test('the Fork button forks the system agent and navigates (replace) to the fork', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce({ ...mockAgent, isSystem: true });
        (agentsService.forkAgent as jest.Mock).mockResolvedValueOnce({
            ...mockAgent,
            graphId: 'graph-fork-001',
            isSystem: false,
            name: 'Default Graph-1-forked',
        });

        renderPage();
        await waitFor(() => expect(screen.getByTestId('edit-agent-fork')).toBeInTheDocument());

        await userEvent.click(screen.getByTestId('edit-agent-fork'));

        await waitFor(() =>
            expect(mockNavigate).toHaveBeenCalledWith('/agents/graph-fork-001', { replace: true })
        );
        expect(agentsService.forkAgent).toHaveBeenCalledWith(mockToken, 'graph-001');
        expect(agentsService.updateAgent).not.toHaveBeenCalled();
        // The form reloads from the fork and becomes editable
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Default Graph-1-forked');
        expect(screen.getByLabelText('Name')).toBeEnabled();
    });

    test('a changed category is included in the update request', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (agentsService.updateAgent as jest.Mock).mockResolvedValueOnce({ ...mockAgent, category: 'MEMORY' });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('agent-category-select')).toBeInTheDocument());

        await userEvent.selectOptions(screen.getByTestId('agent-category-select'), 'MEMORY');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() =>
            expect(agentsService.updateAgent).toHaveBeenCalledWith(mockToken, 'graph-001', { category: 'MEMORY' })
        );
    });

    // ── Client-side validation ────────────────────────────────────────────────

    test('shows error when name is cleared and Save is clicked', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        expect(screen.getByText('Agent name must not be blank.')).toBeInTheDocument();
        expect(agentsService.updateAgent).not.toHaveBeenCalled();
    });

    test('shows error when maxIterations is out of range', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
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
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
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
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
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
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
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

    test('edits node name, input template, and model override', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (agentsService.updateAgent as jest.Mock).mockResolvedValueOnce({ ...mockAgent });

        renderPage();
        await expandNode('Query Analyzer');
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
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        const { container } = renderPage();
        await expandNode('Query Analyzer');
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
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(unknownAgent);
        renderPage();

        await waitFor(() => expect(screen.getByText('Custom Node')).toBeInTheDocument());
        expect(screen.getByText('CUSTOM_NODE_TYPE')).toBeInTheDocument();
    });

    test('handles getAgent error without message property', async () => {
        (agentsService.getAgent as jest.Mock).mockRejectedValueOnce({});
        renderPage();

        await waitFor(() => expect(screen.getByText('Failed to load agent')).toBeInTheDocument());
    });

    test('handles updateAgent error without message property', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (agentsService.updateAgent as jest.Mock).mockRejectedValueOnce({});

        renderPage();
        await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());

        const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Brand New Agent Name');

        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(screen.getByText('Failed to save agent')).toBeInTheDocument());
    });

    test('keeps working when the instruction list fails to load', async () => {
        (agentsService.getAgent as jest.Mock).mockResolvedValueOnce(mockAgent);
        (instructionService.getCustomerInstructions as jest.Mock).mockRejectedValueOnce(new Error('boom'));
        renderPage();
        await expandNode('Result Ranker');

        const search = screen.getByTestId('instruction-search-node-004');
        await userEvent.click(search);
        await waitFor(() => expect(screen.getByText('No instructions found')).toBeInTheDocument());
    });
});
