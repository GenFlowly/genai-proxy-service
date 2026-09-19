import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionAgentSettings } from './ActionAgentSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { getCustomerAgents } from '../../../services/agentsService';
import {
    deleteRequestAgentMapping,
    getRequestAgents,
    putRequestAgentMapping,
} from '../../../services/requestAgentsService';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/agentsService');
jest.mock('../../../services/requestAgentsService');
// Render library select/button as native elements so options are inspectable
jest.mock('@genflowly/component-library', () => ({
    InputSelectWithHint: ({ value, onChange, options, 'data-testid': testId }: any) => (
        <select
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
    PillButton: ({ onClick, label, disabled }: any) => (
        <button onClick={onClick} disabled={disabled}>
            {label}
        </button>
    ),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockGetCustomerAgents = getCustomerAgents as jest.Mock;
const mockGetRequestAgents = getRequestAgents as jest.Mock;
const mockPutRequestAgentMapping = putRequestAgentMapping as jest.Mock;
const mockDeleteRequestAgentMapping = deleteRequestAgentMapping as jest.Mock;

const actionsResponse = {
    entries: [
        {
            requestType: 'CONVERSATION_TITLE',
            displayName: 'Conversation Title Generation',
            templateVariables: ['{{prompt}}'],
            entry: null,
            platformAgentName: 'ConversationTitleDefaultAgent',
        },
        {
            requestType: 'MEMORY_EXTRACTION',
            displayName: 'Learn about User',
            templateVariables: ['{{content}}'],
            entry: {
                scope: 'cust-1',
                requestType: 'MEMORY_EXTRACTION',
                mapKey: 'My Memory Agent',
                graphId: 'GRP2',
                enabled: true,
            },
            platformAgentName: 'MemoryAgent',
        },
    ],
};

const agentsResponse = {
    agents: [
        { graphId: 'GRP1', name: 'Free Agent', requestType: null, isSystem: false },
        { graphId: 'GRP2', name: 'My Memory Agent', requestType: 'MEMORY_EXTRACTION', isSystem: false },
        { graphId: 'GRP3', name: 'System Agent', requestType: null, isSystem: true },
    ],
};

describe('ActionAgentSettings', () => {
    const mockShowToast = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
        mockUseAuth.mockReturnValue({
            customerId: 'cust-1',
            isAuthenticated: true,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        });
        mockGetRequestAgents.mockResolvedValue(actionsResponse);
        mockGetCustomerAgents.mockResolvedValue(agentsResponse);
        mockPutRequestAgentMapping.mockResolvedValue(undefined);
        mockDeleteRequestAgentMapping.mockResolvedValue(undefined);
    });

    async function renderLoaded() {
        render(<ActionAgentSettings />);
        await waitFor(() =>
            expect(screen.getByTestId('action-agent-CONVERSATION_TITLE')).toBeInTheDocument()
        );
    }

    test('renders one row per action with its display name', async () => {
        await renderLoaded();
        expect(screen.getByText('Conversation Title Generation')).toBeInTheDocument();
        expect(screen.getByText('Learn about User')).toBeInTheDocument();
    });

    test('preselects the saved mapping for an overridden action', async () => {
        await renderLoaded();
        const memorySelect = screen.getByTestId('action-agent-MEMORY_EXTRACTION') as HTMLSelectElement;
        expect(memorySelect.value).toBe('GRP2');
        const titleSelect = screen.getByTestId('action-agent-CONVERSATION_TITLE') as HTMLSelectElement;
        expect(titleSelect.value).toBe('__platform_default__');
    });

    test('platform default option names the serving system agent', async () => {
        await renderLoaded();
        const titleSelect = screen.getByTestId('action-agent-CONVERSATION_TITLE');
        expect(
            within(titleSelect).getByText('Platform default — ConversationTitleDefaultAgent')
        ).toBeInTheDocument();
    });

    test('excludes system agents and agents mapped to other actions, keeps the row own mapping', async () => {
        await renderLoaded();
        const titleSelect = screen.getByTestId('action-agent-CONVERSATION_TITLE');
        expect(within(titleSelect).getByText('Free Agent')).toBeInTheDocument();
        expect(within(titleSelect).queryByText('My Memory Agent')).not.toBeInTheDocument();
        expect(within(titleSelect).queryByText('System Agent')).not.toBeInTheDocument();

        const memorySelect = screen.getByTestId('action-agent-MEMORY_EXTRACTION');
        expect(within(memorySelect).getByText('My Memory Agent')).toBeInTheDocument();
    });

    test('saves only changed rows and shows a success toast', async () => {
        await renderLoaded();
        await userEvent.selectOptions(
            screen.getByTestId('action-agent-CONVERSATION_TITLE'),
            'GRP1'
        );
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() =>
            expect(mockPutRequestAgentMapping).toHaveBeenCalledWith(
                'test-token',
                'CONVERSATION_TITLE',
                'GRP1'
            )
        );
        // Memory row unchanged — no write for it
        expect(mockPutRequestAgentMapping).toHaveBeenCalledTimes(1);
        expect(mockDeleteRequestAgentMapping).not.toHaveBeenCalled();
        expect(mockShowToast).toHaveBeenCalledWith('Default actions saved');
    });

    test('clearing a mapping back to platform default deletes the override', async () => {
        await renderLoaded();
        await userEvent.selectOptions(
            screen.getByTestId('action-agent-MEMORY_EXTRACTION'),
            '__platform_default__'
        );
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() =>
            expect(mockDeleteRequestAgentMapping).toHaveBeenCalledWith(
                'test-token',
                'MEMORY_EXTRACTION'
            )
        );
        expect(mockPutRequestAgentMapping).not.toHaveBeenCalled();
    });

    test('shows an error toast when saving fails', async () => {
        mockPutRequestAgentMapping.mockRejectedValueOnce(new Error('Invalid mapping: nope'));
        await renderLoaded();
        await userEvent.selectOptions(
            screen.getByTestId('action-agent-CONVERSATION_TITLE'),
            'GRP1'
        );
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
        await waitFor(() =>
            expect(mockShowToast).toHaveBeenCalledWith('Invalid mapping: nope')
        );
    });

    test('shows a hint when the user has no agents', async () => {
        mockGetCustomerAgents.mockResolvedValue({ agents: [] });
        await renderLoaded();
        expect(
            screen.getByText(/create one on the Agents page/i)
        ).toBeInTheDocument();
    });

    test('shows an error toast when loading fails', async () => {
        mockGetRequestAgents.mockRejectedValueOnce(new Error('boom'));
        render(<ActionAgentSettings />);
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('boom'));
    });
});
