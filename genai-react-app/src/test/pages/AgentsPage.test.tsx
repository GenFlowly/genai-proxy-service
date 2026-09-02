import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';
import AgentsPage from '../../pages/AgentsPage/AgentsPage';
import { useAuth } from '../../context/AuthContext';
import * as agentsService from '../../services/agentsService';

// ── Static mocks ──────────────────────────────────────────────────────────────

jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);

jest.mock('../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}));

const mockSetLeftSidebarExpanded = jest.fn();
const mockSetRightSidebarExpanded = jest.fn();
jest.mock('../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: mockSetLeftSidebarExpanded,
        setRightSidebarExpanded: mockSetRightSidebarExpanded,
    }),
}));

jest.mock('../../hooks/usePageTitle', () => ({
    usePageTitle: jest.fn(),
}));

// Mock react-router-dom navigate
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

// Mock agentsService
jest.mock('../../services/agentsService', () => ({
    getCustomerAgents: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockToken = 'mock-token';
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue(mockToken);

const mockAgent = {
    graphId: 'graph-001',
    name: 'Default Graph',
    isDefault: true,
    entryPoint: 'node-001',
    maxIterations: 10,
    edges: '{}',
    nodes: [
        { nodeId: 'node-001', nodeType: 'QUERY_ANALYZER', name: 'Query Analyzer', config: '{}' },
        { nodeId: 'node-002', nodeType: 'RETRIEVAL',      name: 'Retrieval',      config: '{}' },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPage() {
    return render(
        <MemoryRouter>
            <AgentsPage />
        </MemoryRouter>
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentsPage Component', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (useAuth as jest.Mock).mockReturnValue({
            getAccessTokenSilently: mockGetAccessTokenSilently,
        });
    });

    // ── Loading → empty state ─────────────────────────────────────────────────

    test('renders navbar', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [] });
        renderPage();
        expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });

    test('shows loading spinner initially', () => {
        // Never resolves during this test
        (agentsService.getCustomerAgents as jest.Mock).mockReturnValue(new Promise(() => {}));
        renderPage();
        expect(screen.getByLabelText('Loading agents')).toBeInTheDocument();
    });

    test('shows empty state when no agents are returned', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [] });
        renderPage();
        await waitFor(() => expect(screen.getByText('No agents found')).toBeInTheDocument());
    });

    // ── Sidebar collapse ──────────────────────────────────────────────────────

    test('collapses left and right sidebars on mount', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [] });

        renderPage();

        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(false);
        expect(mockSetRightSidebarExpanded).toHaveBeenCalledWith(false);
    });

    // ── Error state ───────────────────────────────────────────────────────────

    test('shows error message and retry button when fetch fails', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
        renderPage();
        await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    test('retries fetch when Retry button is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock)
            .mockRejectedValueOnce(new Error('Network error'))
            .mockResolvedValueOnce({ agents: [] });

        renderPage();
        await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());

        await userEvent.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(screen.getByText('No agents found')).toBeInTheDocument());
        expect(agentsService.getCustomerAgents).toHaveBeenCalledTimes(2);
    });

    // ── Agent cards ───────────────────────────────────────────────────────────

    test('renders agent cards when agents are returned', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() => expect(screen.getByText('Default Graph')).toBeInTheDocument());
    });

    test('shows Default badge for default agent', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() => expect(screen.getByText('Default')).toBeInTheDocument());
    });

    test('shows node count and max iterations meta in card', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() =>
            expect(screen.getByText(/2 nodes · max 10 iterations/)).toBeInTheDocument()
        );
    });

    test('renders all nodes in the pipeline', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() => expect(screen.getAllByText('Query Analyzer').length).toBeGreaterThan(0));
        expect(screen.getAllByText('Retrieval').length).toBeGreaterThan(0);
    });

    test('renders Edit button for each agent', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /edit agent default graph/i })).toBeInTheDocument()
        );
    });

    // ── Collapsible details ───────────────────────────────────────────────────

    test('expands details section when "Show details" is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() => screen.getByText('▼ Show details'));

        await userEvent.click(screen.getByText('▼ Show details'));
        expect(screen.getByText('Graph ID')).toBeInTheDocument();
        expect(screen.getByText('graph-001')).toBeInTheDocument();
    });

    test('collapses details section when "Hide details" is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() => screen.getByText('▼ Show details'));

        await userEvent.click(screen.getByText('▼ Show details'));
        expect(screen.getByText('▲ Hide details')).toBeInTheDocument();

        await userEvent.click(screen.getByText('▲ Hide details'));
        expect(screen.queryByText('Graph ID')).not.toBeInTheDocument();
    });

    // ── Navigation ────────────────────────────────────────────────────────────

    test('navigates to /agents/:graphId when Edit button is clicked', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() =>
            screen.getByRole('button', { name: /edit agent default graph/i })
        );

        await userEvent.click(screen.getByRole('button', { name: /edit agent default graph/i }));
        expect(mockNavigate).toHaveBeenCalledWith('/agents/graph-001');
    });

    // ── Create agent ──────────────────────────────────────────────────────────

    test('renders a Create agent button that navigates to /agents/new', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument()
        );

        await userEvent.click(screen.getByRole('button', { name: /create agent/i }));
        expect(mockNavigate).toHaveBeenCalledWith('/agents/new');
    });

    // ── System default agents ─────────────────────────────────────────────────

    test('shows System default badge and edit hint for a system agent', async () => {
        const systemAgent = {
            ...mockAgent,
            graphId: 'system-graph-001',
            name: 'Shared Default',
            isSystem: true,
        };
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [systemAgent],
        });
        renderPage();
        await waitFor(() => expect(screen.getByText('System')).toBeInTheDocument());
        expect(
            screen.getByText('Shared system agent — editing it creates your own copy.')
        ).toBeInTheDocument();
    });

    test('does not show System default badge for customer agents', async () => {
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent],
        });
        renderPage();
        await waitFor(() => expect(screen.getByText('Default Graph')).toBeInTheDocument());
        expect(screen.queryByText('System')).not.toBeInTheDocument();
    });

    // ── Multiple agents ───────────────────────────────────────────────────────

    test('renders multiple agent cards', async () => {
        const secondAgent = {
            ...mockAgent,
            graphId: 'graph-002',
            name: 'Reflective Agent',
            isDefault: false,
        };
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({
            agents: [mockAgent, secondAgent],
        });
        renderPage();
        await waitFor(() => expect(screen.getByText('Default Graph')).toBeInTheDocument());
        expect(screen.getByText('Reflective Agent')).toBeInTheDocument();
    });

    test('passes the bearer token to getCustomerAgents', async () => {
        (useAuth as jest.Mock).mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token'),
        });
        (agentsService.getCustomerAgents as jest.Mock).mockResolvedValueOnce({ agents: [] });
        renderPage();
        await waitFor(() => expect(agentsService.getCustomerAgents).toHaveBeenCalledWith('mock-token'));
    });
});
