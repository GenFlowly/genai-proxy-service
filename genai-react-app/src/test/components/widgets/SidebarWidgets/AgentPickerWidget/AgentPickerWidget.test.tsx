import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentPickerWidget from '../../../../../components/widgets/SidebarWidgets/AgentPickerWidget/AgentPickerWidget';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import { useToast } from '../../../../../context/ToastContext';
import * as agentsService from '../../../../../services/agentsService';
import * as configService from '../../../../../services/saveAIConfigService';
import '@testing-library/jest-dom';

jest.mock('../../../../../hooks/useSidebarWidget');
jest.mock('../../../../../context/ToastContext');
jest.mock('../../../../../services/agentsService');
jest.mock('../../../../../services/saveAIConfigService');

jest.mock('../../../../../components/common/SidebarWidgetContainer/SidebarWidgetContainer', () =>
    ({ children, header, headerCollapsed, collapsedContent, 'data-testid': testId }: any) => (
        <div data-testid={testId}>
            <div data-testid="widget-header">{header}</div>
            <div data-testid="widget-header-collapsed">{headerCollapsed}</div>
            <div data-testid="widget-content">{children}</div>
            <div data-testid="widget-collapsed">{collapsedContent}</div>
        </div>
    )
);

jest.mock('@genflowly/component-library', () => ({
    Icon: ({ src }: any) => <span data-testid="icon" />,
    Tooltip: ({ children }: any) => <>{children}</>,
}));

const agent = (overrides: Record<string, any> = {}) => ({
    graphId: 'GRP1',
    name: 'Agent One',
    isDefault: false,
    entryPoint: 'N1',
    maxIterations: 10,
    edges: '{}',
    nodes: [],
    ...overrides,
});

describe('AgentPickerWidget', () => {
    const mockUseSidebarWidget = useSidebarWidget as jest.Mock;
    const mockUseToast = useToast as jest.Mock;
    const mockGetCustomerAgents = agentsService.getCustomerAgents as jest.Mock;
    const mockSavePreferences = configService.saveAIConfigPreferences as jest.Mock;
    const mockSetSelectedAgentId = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();
    const mockShowToast = jest.fn();

    const setup = (selectedAgentId: string | null = null) => {
        mockUseSidebarWidget.mockReturnValue({
            ai: { selectedAgentId, setSelectedAgentId: mockSetSelectedAgentId },
            auth: {
                getAccessTokenSilently: mockGetAccessTokenSilently,
                customerId: 'cust-123',
                isAuthenticated: true,
            },
        });
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
        mockSavePreferences.mockResolvedValue(undefined);
        mockGetAccessTokenSilently.mockResolvedValue('token');
        setup();
    });

    it('lists agents, hiding internal request agents', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-OWN', name: 'My Agent' }),
                agent({ graphId: 'GRP-TITLE', name: 'ConversationTitleAgent', isSystem: true, requestType: 'CONVERSATION_TITLE' }),
            ],
        });

        render(<AgentPickerWidget />);

        expect(await screen.findByTestId('agent-option-GRP-SYS')).toBeInTheDocument();
        expect(screen.getByTestId('agent-option-GRP-OWN')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-option-GRP-TITLE')).not.toBeInTheDocument();
    });

    it('lists only CONVERSATION-category agents; a missing category counts as CONVERSATION', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                // No category attribute (pre-category response) → treated as CONVERSATION
                agent({ graphId: 'GRP-LEGACY', name: 'Legacy Agent', isDefault: true }),
                agent({ graphId: 'GRP-CONV', name: 'Chat Agent', category: 'CONVERSATION' }),
                // Unmapped memory agent (no requestType) must STILL be hidden via category
                agent({ graphId: 'GRP-MEM', name: 'My Memory Agent', category: 'MEMORY' }),
                agent({ graphId: 'GRP-TITLE', name: 'My Title Agent', category: 'TITLE_CREATOR' }),
            ],
        });

        render(<AgentPickerWidget />);

        expect(await screen.findByTestId('agent-option-GRP-LEGACY')).toBeInTheDocument();
        expect(screen.getByTestId('agent-option-GRP-CONV')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-option-GRP-MEM')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-option-GRP-TITLE')).not.toBeInTheDocument();
    });

    it('shows the System default as the dropdown value when no explicit pick', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-OWN', name: 'My Agent' }),
            ],
        });

        render(<AgentPickerWidget />);

        const select = await screen.findByTestId('agent-picker-select');
        expect(select).toHaveValue('GRP-SYS');
    });

    it('prefers the customer-owned default over the System one for the null selection', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-FORK', name: 'Personal', isDefault: true }),
            ],
        });

        render(<AgentPickerWidget />);

        expect(await screen.findByTestId('agent-picker-select')).toHaveValue('GRP-FORK');
    });

    it('a pick becomes the default: stored and saved to the account', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-OWN', name: 'My Agent' }),
            ],
        });

        render(<AgentPickerWidget />);

        const select = await screen.findByTestId('agent-picker-select');
        fireEvent.change(select, { target: { value: 'GRP-OWN' } });
        expect(mockSetSelectedAgentId).toHaveBeenCalledWith('GRP-OWN');
        await waitFor(() =>
            expect(mockSavePreferences).toHaveBeenCalledWith('token', {
                aiConfigPreferences: { preferredAgentId: 'GRP-OWN' },
            })
        );

        fireEvent.change(select, { target: { value: 'GRP-SYS' } });
        expect(mockSetSelectedAgentId).toHaveBeenCalledWith('GRP-SYS');
        await waitFor(() =>
            expect(mockSavePreferences).toHaveBeenCalledWith('token', {
                aiConfigPreferences: { preferredAgentId: 'GRP-SYS' },
            })
        );
    });

    it('marks the picked agent as the one Default, not the isDefault rows', async () => {
        setup('GRP-OTHER');
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-FORK', name: 'Personal', isDefault: true }),
                agent({ graphId: 'GRP-OTHER', name: 'Research Agent' }),
            ],
        });

        render(<AgentPickerWidget />);

        expect(await screen.findByTestId('agent-picker-select')).toHaveValue('GRP-OTHER');
        expect(screen.getByTestId('agent-option-GRP-OTHER')).toHaveTextContent('Research Agent (Default)');
        expect(screen.getByTestId('agent-option-GRP-SYS')).toHaveTextContent(/^Default Smart Agent \(System\)$/);
        expect(screen.getByTestId('agent-option-GRP-FORK')).toHaveTextContent(/^Personal$/);
    });

    it('shows a toast when saving the preference fails', async () => {
        mockSavePreferences.mockRejectedValue(new Error('boom'));
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-OWN', name: 'My Agent' }),
            ],
        });

        render(<AgentPickerWidget />);

        fireEvent.change(await screen.findByTestId('agent-picker-select'), { target: { value: 'GRP-OWN' } });
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save agent preference'));
    });

    it('labels options with System and Default badges', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-OWN', name: 'My Agent' }),
            ],
        });

        render(<AgentPickerWidget />);

        expect(await screen.findByTestId('agent-option-GRP-SYS')).toHaveTextContent(
            'Default Smart Agent (System, Default)'
        );
        expect(screen.getByTestId('agent-option-GRP-OWN')).toHaveTextContent(/^My Agent$/);
    });

    it('clears a stale selection that no longer resolves to an agent', async () => {
        setup('GRP-GONE');
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
            ],
        });

        render(<AgentPickerWidget />);

        await waitFor(() => expect(mockSetSelectedAgentId).toHaveBeenCalledWith(null));
    });

    it('collapsed view shows only the agent icon, no per-agent circles', async () => {
        mockGetCustomerAgents.mockResolvedValue({
            agents: [
                agent({ graphId: 'GRP-SYS', name: 'Default Smart Agent', isSystem: true, isDefault: true }),
                agent({ graphId: 'GRP-OWN', name: 'My Agent' }),
            ],
        });

        render(<AgentPickerWidget />);

        await screen.findByTestId('agent-picker-select');
        expect(screen.getByTestId('agent-collapsed-icon')).toBeInTheDocument();
        // One circle with the current default agent's initials — no per-agent circles
        expect(screen.getByTestId('agent-collapsed-initials')).toHaveTextContent(/^DS$/);
        expect(screen.queryByTestId('agent-collapsed-GRP-SYS')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-collapsed-GRP-OWN')).not.toBeInTheDocument();
    });

    it('shows an error message when loading fails', async () => {
        mockGetCustomerAgents.mockRejectedValue(new Error('boom'));

        render(<AgentPickerWidget />);

        expect(await screen.findByText('Could not load agents')).toBeInTheDocument();
    });
});
