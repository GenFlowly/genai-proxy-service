import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DefaultsSettings } from './DefaultsSettings';
import { useAuth } from '../../../context/AuthContext';
import { useAI } from '../../../context/AIContext';
import { useToast } from '../../../context/ToastContext';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import {
    deleteRequestAgentMapping,
    putRequestAgentMapping,
} from '../../../services/requestAgentsService';
import { getRequestAgents } from '../../../services/requestAgentsService';
import { getCustomerAgents } from '../../../services/agentsService';
import { customerAgentsCache, requestAgentsCache } from '../../../services/defaultsCacheService';
import { withQueryClient } from '../../../test/utils/queryWrapper';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/AIContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/saveAIConfigService');
jest.mock('../../../services/requestAgentsService');
jest.mock('../../../services/agentsService');
// The sibling sections have their own test suites
jest.mock('./EmbeddingModelDefaults', () => ({
    EmbeddingModelDefaults: () => <div data-testid="embedding-defaults-section" />,
}));
jest.mock('./LearnedFactsSettings', () => ({
    LearnedFactsSettings: () => <div data-testid="learned-facts-section" />,
}));
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
const mockUseAI = useAI as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockAgentsFetch = getCustomerAgents as jest.Mock;
const mockActionsFetch = getRequestAgents as jest.Mock;
const mockPutRequestAgentMapping = putRequestAgentMapping as jest.Mock;
const mockDeleteRequestAgentMapping = deleteRequestAgentMapping as jest.Mock;
const mockSavePreferences = saveAIConfigPreferences as jest.Mock;

const actionsResponse = {
    entries: [
        {
            requestType: 'INSTRUCTION_PERSONA',
            displayName: 'Instruction Persona Creation',
            templateVariables: ['{{instructionText}}'],
            entry: null,
            platformAgentName: 'InstructionRequestDefaultAgent',
        },
        {
            requestType: 'CONVERSATION_TITLE',
            displayName: 'Conversation Title Generation',
            templateVariables: ['{{content}}'],
            entry: null,
            platformAgentName: 'TitleCreatorDefaultAgent',
        },
        {
            requestType: 'NOTE_TITLE',
            displayName: 'Note Title Generation',
            templateVariables: ['{{content}}'],
            entry: null,
            platformAgentName: 'TitleCreatorDefaultAgent',
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
        { graphId: 'GRP1', name: 'Free Agent', requestType: null, isSystem: false, category: 'CONVERSATION', isDefault: false },
        { graphId: 'GRP2', name: 'My Memory Agent', requestType: 'MEMORY_EXTRACTION', isSystem: false, category: 'MEMORY', isDefault: false },
        { graphId: 'GRP3', name: 'System Agent', requestType: null, isSystem: true, category: 'CONVERSATION', isDefault: true },
    ],
};

describe('DefaultsSettings', () => {
    const mockShowToast = jest.fn();
    const mockGetAccessTokenSilently = jest.fn();
    const mockSetSelectedAgentId = jest.fn();

    // The seeded caches keep module-level per-customer memory, so each test
    // uses its own customerId — a stale envelope never bleeds across tests.
    let testSeq = 0;
    let customerId = 'cust-0';

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        testSeq += 1;
        customerId = `cust-${testSeq}`;
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockUseToast.mockReturnValue({ showToast: mockShowToast });
        mockUseAuth.mockReturnValue({
            customerId,
            isAuthenticated: true,
            isOnboarding: false,
            cacheVersions: null,
            getAccessTokenSilently: mockGetAccessTokenSilently,
        });
        mockUseAI.mockReturnValue({
            selectedAgentId: null,
            setSelectedAgentId: mockSetSelectedAgentId,
        });
        mockActionsFetch.mockResolvedValue(actionsResponse);
        mockAgentsFetch.mockResolvedValue(agentsResponse);
        mockPutRequestAgentMapping.mockResolvedValue(undefined);
        mockDeleteRequestAgentMapping.mockResolvedValue(undefined);
        mockSavePreferences.mockResolvedValue(undefined);
    });

    async function renderLoaded() {
        render(withQueryClient(<DefaultsSettings />));
        await waitFor(() =>
            expect(screen.getByTestId('default-agent-TITLE')).toBeInTheDocument()
        );
    }

    test('renders the agent rows in order, merging the two title flows into one Title Agent row', async () => {
        await renderLoaded();
        expect(screen.getByText('Title Agent')).toBeInTheDocument();
        expect(screen.getByText('Learn about Me Agent')).toBeInTheDocument();
        expect(screen.getByText('Instruction Persona Agent')).toBeInTheDocument();
        expect(screen.getByText('Conversation Agent')).toBeInTheDocument();

        // The merged row replaces the two per-flow rows and server labels
        expect(screen.queryByText('Conversation Title Generation')).not.toBeInTheDocument();
        expect(screen.queryByText('Note Title Generation')).not.toBeInTheDocument();
        expect(screen.queryByTestId('default-agent-CONVERSATION_TITLE')).not.toBeInTheDocument();
        expect(screen.queryByTestId('default-agent-NOTE_TITLE')).not.toBeInTheDocument();

        const selects = screen.getAllByRole('combobox');
        expect(selects.map(s => s.getAttribute('data-testid'))).toEqual([
            'default-agent-TITLE',
            'default-agent-MEMORY_EXTRACTION',
            'default-agent-INSTRUCTION_PERSONA',
            'default-agent-CONVERSATION',
        ]);
    });

    test('renders the embedding defaults section', async () => {
        await renderLoaded();
        expect(screen.getByTestId('embedding-defaults-section')).toBeInTheDocument();
    });

    test('renders the learned facts section', async () => {
        await renderLoaded();
        expect(screen.getByTestId('learned-facts-section')).toBeInTheDocument();
    });

    test('an unknown future action still renders, labeled by its server display name', async () => {
        mockActionsFetch.mockResolvedValue({
            entries: [
                ...actionsResponse.entries,
                {
                    requestType: 'SOMETHING_NEW',
                    displayName: 'Something New',
                    templateVariables: [],
                    entry: null,
                    platformAgentName: null,
                },
            ],
        });
        await renderLoaded();
        expect(screen.getByText('Something New')).toBeInTheDocument();
        expect(screen.getByTestId('default-agent-SOMETHING_NEW')).toBeInTheDocument();
    });

    test('preselects the saved mapping for an overridden action', async () => {
        await renderLoaded();
        const memorySelect = screen.getByTestId('default-agent-MEMORY_EXTRACTION') as HTMLSelectElement;
        expect(memorySelect.value).toBe('GRP2');
        const titleSelect = screen.getByTestId('default-agent-TITLE') as HTMLSelectElement;
        expect(titleSelect.value).toBe('__platform_default__');
    });

    test('preselects the Title Agent row from an existing title mapping', async () => {
        mockActionsFetch.mockResolvedValue({
            entries: actionsResponse.entries.map(entry =>
                entry.requestType === 'CONVERSATION_TITLE'
                    ? {
                        ...entry,
                        entry: {
                            scope: 'cust-1',
                            requestType: 'CONVERSATION_TITLE',
                            mapKey: 'Free Agent',
                            graphId: 'GRP1',
                            enabled: true,
                        },
                    }
                    : entry
            ),
        });
        await renderLoaded();
        expect(screen.getByTestId('default-agent-TITLE')).toHaveValue('GRP1');
    });

    test('platform default option names the serving system agent', async () => {
        await renderLoaded();
        const titleSelect = screen.getByTestId('default-agent-TITLE');
        expect(
            within(titleSelect).getByText('Platform default — TitleCreatorDefaultAgent')
        ).toBeInTheDocument();
    });

    test('excludes system agents and agents mapped to other actions, keeps the row own mapping', async () => {
        await renderLoaded();
        const titleSelect = screen.getByTestId('default-agent-TITLE');
        expect(within(titleSelect).getByText('Free Agent')).toBeInTheDocument();
        expect(within(titleSelect).queryByText('My Memory Agent')).not.toBeInTheDocument();
        expect(within(titleSelect).queryByText('System Agent')).not.toBeInTheDocument();

        const memorySelect = screen.getByTestId('default-agent-MEMORY_EXTRACTION');
        expect(within(memorySelect).getByText('My Memory Agent')).toBeInTheDocument();
    });

    test('picking a Title Agent saves the mapping for both title request types', async () => {
        await renderLoaded();
        await userEvent.selectOptions(screen.getByTestId('default-agent-TITLE'), 'GRP1');
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() =>
            expect(mockPutRequestAgentMapping).toHaveBeenCalledWith(
                'test-token',
                'CONVERSATION_TITLE',
                'GRP1'
            )
        );
        expect(mockPutRequestAgentMapping).toHaveBeenCalledWith(
            'test-token',
            'NOTE_TITLE',
            'GRP1'
        );
        // Memory and persona rows unchanged — no writes for them
        expect(mockPutRequestAgentMapping).toHaveBeenCalledTimes(2);
        expect(mockDeleteRequestAgentMapping).not.toHaveBeenCalled();
        expect(mockShowToast).toHaveBeenCalledWith('Default agents saved');
    });

    test('clearing a mapping back to platform default deletes the override', async () => {
        await renderLoaded();
        await userEvent.selectOptions(
            screen.getByTestId('default-agent-MEMORY_EXTRACTION'),
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

    test('Conversation Agent preselects the effective default and lists System agents badged', async () => {
        await renderLoaded();
        const conversationSelect = screen.getByTestId('default-agent-CONVERSATION') as HTMLSelectElement;
        // No user pick, no own default graph → the System default agent
        expect(conversationSelect.value).toBe('GRP3');
        expect(within(conversationSelect).getByText('System Agent (System)')).toBeInTheDocument();
        expect(within(conversationSelect).getByText('Free Agent')).toBeInTheDocument();
        // Non-conversation agents stay out
        expect(within(conversationSelect).queryByText('My Memory Agent')).not.toBeInTheDocument();
    });

    test('changing the Conversation Agent saves the preferred agent and updates the AI context', async () => {
        await renderLoaded();
        await userEvent.selectOptions(screen.getByTestId('default-agent-CONVERSATION'), 'GRP1');
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() =>
            expect(mockSavePreferences).toHaveBeenCalledWith('test-token', {
                aiConfigPreferences: { preferredAgentId: 'GRP1' },
            })
        );
        expect(mockSetSelectedAgentId).toHaveBeenCalledWith('GRP1');
        // Mapping rows untouched
        expect(mockPutRequestAgentMapping).not.toHaveBeenCalled();
        expect(mockDeleteRequestAgentMapping).not.toHaveBeenCalled();
    });

    test('an unchanged Conversation Agent is not re-saved', async () => {
        await renderLoaded();
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Default agents saved'));
        expect(mockSavePreferences).not.toHaveBeenCalled();
        expect(mockSetSelectedAgentId).not.toHaveBeenCalled();
    });

    test('shows an error toast when saving fails', async () => {
        mockPutRequestAgentMapping.mockRejectedValueOnce(new Error('Invalid mapping: nope'));
        await renderLoaded();
        await userEvent.selectOptions(screen.getByTestId('default-agent-TITLE'), 'GRP1');
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
        await waitFor(() =>
            expect(mockShowToast).toHaveBeenCalledWith('Invalid mapping: nope')
        );
    });

    test('shows a hint when the user has no agents', async () => {
        mockAgentsFetch.mockResolvedValue({ agents: [] });
        await renderLoaded();
        expect(
            screen.getByText(/create one on the Agents page/i)
        ).toBeInTheDocument();
    });

    test('shows an error toast when loading fails with no cache to fall back on', async () => {
        mockActionsFetch.mockRejectedValueOnce(new Error('boom'));
        render(withQueryClient(<DefaultsSettings />));
        await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('boom'));
    });

    test('renders instantly from cached data while the server refresh is pending', async () => {
        requestAgentsCache.save(customerId, actionsResponse as any, null);
        customerAgentsCache.save(customerId, agentsResponse as any, null);
        mockActionsFetch.mockReturnValue(new Promise(() => undefined));
        mockAgentsFetch.mockReturnValue(new Promise(() => undefined));

        render(withQueryClient(<DefaultsSettings />));

        expect(await screen.findByTestId('default-agent-TITLE')).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
        expect(screen.getByTestId('default-agent-MEMORY_EXTRACTION')).toHaveValue('GRP2');
    });

    test('an unchanged background refresh does not reset an in-progress edit', async () => {
        requestAgentsCache.save(customerId, actionsResponse as any, null);
        customerAgentsCache.save(customerId, agentsResponse as any, null);
        let resolveActions: (value: unknown) => void = () => undefined;
        mockActionsFetch.mockReturnValue(new Promise(resolve => { resolveActions = resolve; }));
        mockAgentsFetch.mockResolvedValue(JSON.parse(JSON.stringify(agentsResponse)));

        render(withQueryClient(<DefaultsSettings />));
        await userEvent.selectOptions(await screen.findByTestId('default-agent-TITLE'), 'GRP1');

        resolveActions(JSON.parse(JSON.stringify(actionsResponse)));
        await waitFor(() => expect(mockActionsFetch).toHaveBeenCalled());

        expect(screen.getByTestId('default-agent-TITLE')).toHaveValue('GRP1');
    });

    test('a failed refresh keeps the cached data without an error toast', async () => {
        requestAgentsCache.save(customerId, actionsResponse as any, null);
        customerAgentsCache.save(customerId, agentsResponse as any, null);
        mockActionsFetch.mockRejectedValue(new Error('offline'));
        mockAgentsFetch.mockRejectedValue(new Error('offline'));

        render(withQueryClient(<DefaultsSettings />));

        expect(await screen.findByTestId('default-agent-TITLE')).toBeInTheDocument();
        await waitFor(() => expect(mockActionsFetch).toHaveBeenCalled());
        expect(mockShowToast).not.toHaveBeenCalled();
    });
});
