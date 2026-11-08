import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom';
import GraphAgentEditorPage from '../../../pages/AgentsPage/GraphAgentEditorPage/GraphAgentEditorPage';
import { useAuth } from '../../../context/AuthContext';
import * as agentsService from '../../../services/agentsService';
import * as instructionService from '../../../services/instructionService';
import * as nodePresetsService from '../../../services/nodePresetsService';
import type { Agent } from '../../../models/agents.models';

// ── Static mocks ──────────────────────────────────────────────────────────────

// CRA's jsdom can't render React Flow — mock the whole library and capture the
// props the page passes to GraphEditor so tests can inspect them and drive
// onSave / onDirtyChange directly.
let mockGraphEditorProps: any = null;
jest.mock('@genflowly/component-library', () => ({
    GraphEditor: (props: any) => {
        mockGraphEditorProps = props;
        return <div data-testid="graph-editor" />;
    },
    Icon: ({ src }: { src: string }) => <span data-testid="icon" data-src={src} />,
    // Trimmed stand-in for the library's primitive metadata (hasPrompt derivation)
    DEFAULT_NODE_TYPE_INFOS: [
        { nodeType: 'GENERATION', label: 'LLM', hasPrompt: true },
        { nodeType: 'MEMORY', label: 'Memory', hasPrompt: false },
        { nodeType: 'RETRIEVAL', label: 'Retrieval', hasPrompt: false },
        { nodeType: 'QUERY_ANALYZER', label: 'LLM', hasPrompt: true },
    ],
}));

jest.mock('../../../components/navbar/Navbar', () => () => <div data-testid="navbar" />);
jest.mock('../../../components/widgets/MobileHeader/MobileHeader', () => ({ swipeBack }: { swipeBack?: { to: string } }) => (
    <div data-testid="mobile-header" data-swipe-back={swipeBack?.to} />
));

jest.mock('../../../context/AuthContext', () => ({ useAuth: jest.fn() }));

jest.mock('../../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: jest.fn(),
        setRightSidebarExpanded: jest.fn(),
    }),
}));

jest.mock('../../../hooks/usePageTitle', () => ({ usePageTitle: jest.fn() }));

// Vendor display names come from the provider catalog; mocked with
// catalog-shaped names so labels are deterministic.
jest.mock('../../../hooks/useVendorDisplayNames', () => ({
    useVendorDisplayNames: () => (vendorId: string) =>
        ({ OPENAI: 'OpenAI', CLAUDE: 'Anthropic', GEMINI: 'Google Gemini' } as Record<string, string>)[vendorId] ?? vendorId,
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../../services/agentsService', () => ({
    getAgent: jest.fn(),
    getCachedAgent: jest.fn(() => null),
    createGraphAgent: jest.fn(),
    updateAgent: jest.fn(),
    forkAgent: jest.fn(),
}));

jest.mock('../../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn(),
}));

jest.mock('../../../services/nodePresetsService', () => ({
    getNodePresets: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockToken = 'mock-token';

const baseAgent: Agent = {
    graphId: 'graph-001',
    name: 'Default Graph',
    isDefault: true,
    entryPoint: 'node-001',
    maxIterations: 10,
    edges: '{"edges":[{"from":"node-001","to":"node-002"},{"from":"node-002","to":"__end__"}],"conditional_edges":[]}',
    layout: '{"positions":{"node-001":{"x":0,"y":0},"node-002":{"x":0,"y":160}}}',
    nodes: [
        {
            nodeId: 'node-001',
            nodeType: 'QUERY_ANALYZER',
            name: 'Query Analyzer',
            config: '{"input_template":"{query}"}',
        },
        {
            nodeId: 'node-002',
            nodeType: 'RESPONSE_GENERATOR',
            name: 'Response Generator',
            config: '{}',
        },
    ],
};

/** AgentGraph as the editor would emit it, unchanged, from the loaded agent. */
function emittedFrom(agent: Agent) {
    return {
        graphId: agent.graphId,
        name: agent.name,
        isDefault: agent.isDefault,
        entryPoint: agent.entryPoint,
        maxIterations: agent.maxIterations,
        edges: agent.edges,
        layout: agent.layout,
        nodes: agent.nodes.map(n => ({
            nodeId: n.nodeId,
            nodeType: n.nodeType,
            name: n.name,
            config: n.config,
        })),
    };
}

const mockPresets = [
    {
        presetId: 'preset-1',
        name: 'Query Analyzer',
        nodeType: 'QUERY_ANALYZER',
        description: 'Classifies the query intent.',
        config: '{"response_format":"json"}',
        requiredAttributes: ['Prompt via instruction', 'Writes query_intent'],
        sortOrder: 1,
    },
    {
        presetId: 'preset-2',
        name: 'User Memory',
        nodeType: 'MEMORY',
        description: 'Injects learned user memories.',
        config: '{"max_memories":20}',
        requiredAttributes: [],
        sortOrder: 2,
    },
    {
        presetId: 'preset-3',
        name: 'Shiny New Node',
        nodeType: 'BRAND_NEW_TYPE',
        description: 'A preset for a type the library does not know yet.',
        config: '{}',
        requiredAttributes: ['Does something new'],
        sortOrder: 3,
    },
];

const mockInstructions = [
    { id: 'inst-1', name: 'Analyzer Prompt', version: 2, instruction: 'Old analyzer text' },
    { id: 'inst-1', name: 'Analyzer Prompt', version: 3, instruction: 'A'.repeat(300) },
    { id: 'inst-2', name: 'Rewriter Prompt', version: 1, instruction: 'Rewriter text' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function setViewport(desktop: boolean) {
    window.matchMedia = ((query: string) => ({
        matches: desktop,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
    })) as any;
}

function renderAt(path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/agents/new" element={<GraphAgentEditorPage />} />
                <Route path="/agents/:graphId" element={<GraphAgentEditorPage />} />
            </Routes>
        </MemoryRouter>
    );
}

async function renderLoadedEditor(agent: Agent = baseAgent, path = `/agents/${agent.graphId}`) {
    (agentsService.getAgent as jest.Mock).mockResolvedValue(agent);
    renderAt(path);
    await waitFor(() => expect(screen.getByTestId('graph-editor')).toBeInTheDocument());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GraphAgentEditorPage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGraphEditorProps = null;
        setViewport(true);
        (useAuth as jest.Mock).mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue(mockToken),
        });
        (instructionService.getCustomerInstructions as jest.Mock).mockResolvedValue({
            instructions: mockInstructions,
        });
        (nodePresetsService.getNodePresets as jest.Mock).mockResolvedValue({
            presets: mockPresets,
        });
    });

    // ── Desktop: loading + props ──────────────────────────────────────────────

    test('loads the agent and passes the graph to GraphEditor', async () => {
        await renderLoadedEditor();

        expect(agentsService.getAgent).toHaveBeenCalledWith(mockToken, 'graph-001');
        expect(mockGraphEditorProps.graph).toEqual(emittedFrom(baseAgent));
    });

    test('shows the load error with a back link when getAgent fails', async () => {
        (agentsService.getAgent as jest.Mock).mockRejectedValue(new Error('Get Agent failed: 404 Not Found'));
        renderAt('/agents/missing');
        await waitFor(() =>
            expect(screen.getByText('Get Agent failed: 404 Not Found')).toBeInTheDocument()
        );
        expect(screen.getByRole('link', { name: 'Back to Agents' })).toHaveAttribute('href', '/agents');
        expect(screen.queryByTestId('graph-editor')).not.toBeInTheDocument();
    });

    test('passes instructions (deduped to latest version, with preview) to the editor', async () => {
        await renderLoadedEditor();

        await waitFor(() => expect(mockGraphEditorProps.instructions).toHaveLength(2));
        const analyzer = mockGraphEditorProps.instructions.find((i: any) => i.instructionId === 'inst-1');
        expect(analyzer.latestVersion).toBe(3);
        expect(analyzer.preview).toHaveLength(200);
        expect(mockGraphEditorProps.instructions[1]).toEqual(
            expect.objectContaining({ instructionId: 'inst-2', name: 'Rewriter Prompt', latestVersion: 1 })
        );
    });

    test('passes only valid-key vendors to the editor for the node model preference', async () => {
        (useAuth as jest.Mock).mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue(mockToken),
            customerId: 'cust-1',
            aiVendorAPIKeyStatusList: [
                { aiVendor: 'OPENAI', status: 'API key is valid', isAPIKeyValid: true },
                { aiVendor: 'CLAUDE', status: 'API Key is not set', isAPIKeyValid: false },
                { aiVendor: 'GEMINI', status: 'API key is valid', isAPIKeyValid: true },
            ],
        });
        await renderLoadedEditor();

        await waitFor(() => expect(mockGraphEditorProps.vendors).toHaveLength(2));
        expect(mockGraphEditorProps.vendors).toEqual([
            { id: 'OPENAI', label: 'OpenAI' },
            { id: 'GEMINI', label: 'Google Gemini' },
        ]);
        expect(typeof mockGraphEditorProps.getModelsForVendor).toBe('function');
    });

    test('passes the fetched node presets as the catalog and the condition options to the editor', async () => {
        await renderLoadedEditor();

        expect(nodePresetsService.getNodePresets).toHaveBeenCalledWith(mockToken);
        await waitFor(() => expect(mockGraphEditorProps.nodeCatalog).toHaveLength(3));
        expect(mockGraphEditorProps.nodeCatalog).toEqual([
            {
                // hasPrompt derived from the library's QUERY_ANALYZER primitive
                nodeType: 'QUERY_ANALYZER',
                label: 'Query Analyzer',
                description: 'Classifies the query intent.',
                defaultConfig: '{"response_format":"json"}',
                hasPrompt: true,
                requiredAttributes: ['Prompt via instruction', 'Writes query_intent'],
            },
            {
                // empty requiredAttributes → undefined, so the primitive's contract shows
                nodeType: 'MEMORY',
                label: 'User Memory',
                description: 'Injects learned user memories.',
                defaultConfig: '{"max_memories":20}',
                hasPrompt: false,
                requiredAttributes: undefined,
            },
            {
                // unknown node type → hasPrompt falls back to false
                nodeType: 'BRAND_NEW_TYPE',
                label: 'Shiny New Node',
                description: 'A preset for a type the library does not know yet.',
                defaultConfig: '{}',
                hasPrompt: false,
                requiredAttributes: ['Does something new'],
            },
        ]);
        expect(mockGraphEditorProps.conditionOptions).toEqual([
            { key: 'needs_rewrite', type: 'bool', label: 'Needs rewrite' },
            { key: 'needs_more_context', type: 'bool', label: 'Needs more context' },
            { key: 'retrieval_results', type: 'list_empty', label: 'Retrieval results empty' },
            { key: 'error', type: 'bool', label: 'Error occurred' },
        ]);
    });

    test('renders the editor with an empty catalog when getNodePresets fails', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        (nodePresetsService.getNodePresets as jest.Mock).mockRejectedValue(
            new Error('Get Node Presets failed: 500 Internal Server Error')
        );
        await renderLoadedEditor();

        await waitFor(() => expect(mockGraphEditorProps.nodeCatalog).toEqual([]));
        expect(screen.getByTestId('graph-editor')).toBeInTheDocument();
        errorSpy.mockRestore();
    });

    test('renders a system agent read-only with the fork banner', async () => {
        await renderLoadedEditor({ ...baseAgent, isSystem: true });
        expect(
            screen.getByText('This is a shared system agent — it is read-only. Fork it to make an editable copy.')
        ).toBeInTheDocument();
        expect(screen.getByTestId('graph-editor-fork')).toBeInTheDocument();
        expect(mockGraphEditorProps.readOnly).toBe(true);
        // No category select for read-only agents
        expect(screen.queryByTestId('agent-category-select')).not.toBeInTheDocument();
    });

    test('own agents render editable with the category select', async () => {
        await renderLoadedEditor({ ...baseAgent, category: 'MEMORY' } as Agent);
        expect(mockGraphEditorProps.readOnly).toBe(false);
        expect(screen.queryByTestId('graph-editor-fork')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-category-select')).toHaveValue('MEMORY');
    });

    test('changing the category on an existing agent saves immediately', async () => {
        (agentsService.updateAgent as jest.Mock).mockResolvedValue({ ...baseAgent, category: 'MEMORY' });
        await renderLoadedEditor();

        const select = screen.getByTestId('agent-category-select');
        await act(async () => {
            const { fireEvent } = await import('@testing-library/react');
            fireEvent.change(select, { target: { value: 'MEMORY' } });
        });

        await waitFor(() =>
            expect(agentsService.updateAgent).toHaveBeenCalledWith(mockToken, 'graph-001', { category: 'MEMORY' })
        );
    });

    test('opens /instructions in a new tab on onRequestCreateInstruction', async () => {
        const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
        await renderLoadedEditor();

        act(() => mockGraphEditorProps.onRequestCreateInstruction());
        expect(openSpy).toHaveBeenCalledWith('/instructions', '_blank');
        openSpy.mockRestore();
    });

    // ── Save diffing (existing agent) ─────────────────────────────────────────

    test('save with a changed config on an existing node sends only a node patch', async () => {
        (agentsService.updateAgent as jest.Mock).mockResolvedValue({ ...baseAgent });
        await renderLoadedEditor();

        const emitted = emittedFrom(baseAgent);
        emitted.nodes[0] = { ...emitted.nodes[0], config: '{"input_template":"{query} extra"}' };

        await act(async () => mockGraphEditorProps.onSave(emitted));

        await waitFor(() => expect(agentsService.updateAgent).toHaveBeenCalledTimes(1));
        expect(agentsService.updateAgent).toHaveBeenCalledWith(mockToken, 'graph-001', {
            nodes: [{ nodeId: 'node-001', config: '{"input_template":"{query} extra"}' }],
        });
    });

    test('save with an added node sends addNodes with the tempId and the new edges', async () => {
        (agentsService.updateAgent as jest.Mock).mockResolvedValue({ ...baseAgent });
        await renderLoadedEditor();

        const newEdges =
            '{"edges":[{"from":"node-001","to":"new-1"},{"from":"new-1","to":"node-002"},{"from":"node-002","to":"__end__"}],"conditional_edges":[]}';
        const newLayout =
            '{"positions":{"node-001":{"x":0,"y":0},"new-1":{"x":0,"y":160},"node-002":{"x":0,"y":320}}}';
        const emitted = emittedFrom(baseAgent);
        emitted.edges = newEdges;
        emitted.layout = newLayout;
        emitted.nodes = [
            emitted.nodes[0],
            { nodeId: 'new-1', nodeType: 'WEB_SEARCH', name: 'Web Search', config: '{}' },
            emitted.nodes[1],
        ];

        await act(async () => mockGraphEditorProps.onSave(emitted));

        await waitFor(() => expect(agentsService.updateAgent).toHaveBeenCalledTimes(1));
        expect(agentsService.updateAgent).toHaveBeenCalledWith(mockToken, 'graph-001', {
            edges: newEdges,
            layout: newLayout,
            addNodes: [{ tempId: 'new-1', nodeType: 'WEB_SEARCH', name: 'Web Search', config: '{}' }],
        });
    });

    test('save with a removed node sends removeNodeIds', async () => {
        (agentsService.updateAgent as jest.Mock).mockResolvedValue({ ...baseAgent });
        await renderLoadedEditor();

        const newEdges = '{"edges":[{"from":"node-001","to":"__end__"}],"conditional_edges":[]}';
        const emitted = emittedFrom(baseAgent);
        emitted.edges = newEdges;
        emitted.nodes = [emitted.nodes[0]];

        await act(async () => mockGraphEditorProps.onSave(emitted));

        await waitFor(() => expect(agentsService.updateAgent).toHaveBeenCalledTimes(1));
        expect(agentsService.updateAgent).toHaveBeenCalledWith(mockToken, 'graph-001', {
            edges: newEdges,
            removeNodeIds: ['node-002'],
        });
    });

    test('save with changed name, maxIterations and entryPoint sends only those fields', async () => {
        (agentsService.updateAgent as jest.Mock).mockResolvedValue({ ...baseAgent });
        await renderLoadedEditor();

        const emitted = emittedFrom(baseAgent);
        emitted.name = 'Renamed';
        emitted.maxIterations = 20;
        emitted.entryPoint = 'node-002';

        await act(async () => mockGraphEditorProps.onSave(emitted));

        await waitFor(() => expect(agentsService.updateAgent).toHaveBeenCalledTimes(1));
        expect(agentsService.updateAgent).toHaveBeenCalledWith(mockToken, 'graph-001', {
            name: 'Renamed',
            maxIterations: 20,
            entryPoint: 'node-002',
        });
    });

    test('the Fork button forks the system agent and navigates (replace) to the fork', async () => {
        (agentsService.forkAgent as jest.Mock).mockResolvedValue({
            ...baseAgent,
            graphId: 'graph-fork-001',
            name: 'Default Graph-1-forked',
            isSystem: false,
        });
        await renderLoadedEditor({ ...baseAgent, isSystem: true });

        const userEvent = (await import('@testing-library/user-event')).default;
        await userEvent.click(screen.getByTestId('graph-editor-fork'));

        await waitFor(() =>
            expect(mockNavigate).toHaveBeenCalledWith('/agents/graph-fork-001', { replace: true })
        );
        expect(agentsService.forkAgent).toHaveBeenCalledWith(mockToken, 'graph-001');
        expect(agentsService.updateAgent).not.toHaveBeenCalled();
    });

    test('passes the server error message to the editor when updateAgent fails', async () => {
        (agentsService.updateAgent as jest.Mock).mockRejectedValue(
            new Error('entryPoint nodeId not in graph')
        );
        await renderLoadedEditor();

        const emitted = emittedFrom(baseAgent);
        emitted.name = 'Broken';
        await act(async () => mockGraphEditorProps.onSave(emitted));

        await waitFor(() =>
            expect(mockGraphEditorProps.errorMessage).toBe('entryPoint nodeId not in graph')
        );
        expect(mockGraphEditorProps.saving).toBe(false);
        expect(mockNavigate).not.toHaveBeenCalled();
    });

    // ── Create flow (/agents/new) ─────────────────────────────────────────────

    test('renders the editor with a null graph on /agents/new without fetching', async () => {
        renderAt('/agents/new');
        await waitFor(() => expect(screen.getByTestId('graph-editor')).toBeInTheDocument());
        expect(mockGraphEditorProps.graph).toBeNull();
        expect(agentsService.getAgent).not.toHaveBeenCalled();
    });

    test('create flow posts CreateGraphAgentRequest with tempIds and navigates to the new graph', async () => {
        (agentsService.createGraphAgent as jest.Mock).mockResolvedValue({
            ...baseAgent,
            graphId: 'graph-created-1',
            name: 'Fresh Agent',
        });
        renderAt('/agents/new');
        await waitFor(() => expect(screen.getByTestId('graph-editor')).toBeInTheDocument());

        const edges = '{"edges":[{"from":"new-1","to":"new-2"},{"from":"new-2","to":"__end__"}],"conditional_edges":[]}';
        const layout = '{"positions":{"new-1":{"x":0,"y":0},"new-2":{"x":0,"y":160}}}';
        await act(async () =>
            mockGraphEditorProps.onSave({
                name: 'Fresh Agent',
                entryPoint: 'new-1',
                maxIterations: 10,
                edges,
                layout,
                nodes: [
                    { nodeId: 'new-1', nodeType: 'RETRIEVAL', name: 'Retrieval', config: '{}' },
                    { nodeId: 'new-2', nodeType: 'RESPONSE_GENERATOR', name: 'Responder', config: '{"is_streaming":true}' },
                ],
            })
        );

        await waitFor(() => expect(agentsService.createGraphAgent).toHaveBeenCalledTimes(1));
        expect(agentsService.createGraphAgent).toHaveBeenCalledWith(mockToken, {
            name: 'Fresh Agent',
            maxIterations: 10,
            entryPoint: 'new-1',
            edges,
            layout,
            category: 'CONVERSATION',
            nodes: [
                { tempId: 'new-1', nodeType: 'RETRIEVAL', name: 'Retrieval', config: '{}' },
                { tempId: 'new-2', nodeType: 'RESPONSE_GENERATOR', name: 'Responder', config: '{"is_streaming":true}' },
            ],
        });
        expect(mockNavigate).toHaveBeenCalledWith('/agents/graph-created-1', { replace: true });
    });

    test('passes the server error message to the editor when createGraphAgent fails', async () => {
        (agentsService.createGraphAgent as jest.Mock).mockRejectedValue(new Error('edges JSON invalid'));
        renderAt('/agents/new');
        await waitFor(() => expect(screen.getByTestId('graph-editor')).toBeInTheDocument());

        await act(async () =>
            mockGraphEditorProps.onSave({
                name: 'Bad Agent',
                entryPoint: 'new-1',
                maxIterations: 10,
                edges: 'not json',
                nodes: [{ nodeId: 'new-1', nodeType: 'RETRIEVAL', name: 'Retrieval', config: '{}' }],
            })
        );

        await waitFor(() => expect(mockGraphEditorProps.errorMessage).toBe('edges JSON invalid'));
        expect(mockNavigate).not.toHaveBeenCalled();
    });

    // ── Small screens ─────────────────────────────────────────────────────────

    test('small screen /agents/:graphId shows the desktop notice with the agent link', () => {
        setViewport(false);
        renderAt('/agents/graph-001');

        expect(screen.getByText('Desktop screen needed')).toBeInTheDocument();
        expect(screen.getByText(/This agent can only be viewed or edited on a desktop screen/)).toBeInTheDocument();
        expect(screen.getByTestId('agent-desktop-url')).toHaveTextContent(`${window.location.origin}/agents/graph-001`);
        expect(screen.getByRole('link', { name: 'Back to Agents' })).toHaveAttribute('href', '/agents');
        expect(screen.getByTestId('mobile-header')).toHaveAttribute('data-swipe-back', '/agents');
        expect(screen.queryByTestId('graph-editor')).not.toBeInTheDocument();
        expect(agentsService.getAgent).not.toHaveBeenCalled();
    });

    test('small screen /agents/new shows the desktop notice with the create link', () => {
        setViewport(false);
        renderAt('/agents/new');

        expect(screen.getByText(/Agents can only be created on a desktop screen/)).toBeInTheDocument();
        expect(screen.getByTestId('agent-desktop-url')).toHaveTextContent(`${window.location.origin}/agents/new`);
        expect(screen.queryByTestId('graph-editor')).not.toBeInTheDocument();
    });

    test('Copy puts the link on the clipboard and confirms it', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        setViewport(false);
        renderAt('/agents/graph-001');

        await act(async () => {
            screen.getByRole('button', { name: 'Copy' }).click();
        });

        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/agents/graph-001`);
        expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument();
    });

    test('a failed copy leaves the button as it was', async () => {
        const writeText = jest.fn().mockRejectedValue(new Error('denied'));
        Object.assign(navigator, { clipboard: { writeText } });
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        setViewport(false);
        renderAt('/agents/graph-001');

        await act(async () => {
            screen.getByRole('button', { name: 'Copy' }).click();
        });

        expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
        consoleError.mockRestore();
    });
});
