import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import InstructionPickerModal from '../../../../components/common/InstructionPickerModal/InstructionPickerModal';
import { MemoryRouter } from 'react-router-dom';
import * as instructionService from '../../../../services/instructionService';
import { SearchError } from '../../../../services/searchError';
import { loadRecentInstructionsCache, saveRecentInstructionsCache, clearRecentInstructionsCache } from '../../../../components/common/InstructionPickerModal/recentInstructionsCache';

const mockAuth = { isAuthenticated: true, isSignedOut: false };
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: () => ({
        customerId: 'cust-1',
        isAuthenticated: mockAuth.isAuthenticated,
        isSignedOut: mockAuth.isSignedOut,
        getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token')
    })
}));
jest.mock('../../../../services/instructionService');

const mockGetRecent = instructionService.getRecentInstructions as jest.Mock;
const mockSearch = instructionService.searchInstructions as jest.Mock;

const recentInstruction = {
    id: 'inst-1', name: 'Physics Wave Expert', version: 3,
    instruction: 'You are an expert in physics.', icon: '🔍⚡', color: '#059669',
    tags: ['physics'], role: 'OWNER'
};
const searchedInstruction = {
    id: 'inst-2', name: 'H1B Tax Advisor', version: 1,
    instruction: 'You are an immigration and Tax expert.', role: 'OWNER'
};

describe('InstructionPickerModal', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.isAuthenticated = true;
        mockAuth.isSignedOut = false;
        clearRecentInstructionsCache(); // The module-level SWR cache must not leak between tests
        mockGetRecent.mockResolvedValue({ instructions: [recentInstruction] });
        mockSearch.mockResolvedValue({ instructions: [searchedInstruction] });
    });

    test('shows recently used instructions when opened', async () => {
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        expect(await screen.findByText('Physics Wave Expert')).toBeInTheDocument();
        expect(screen.getByText('Recently used')).toBeInTheDocument();
        expect(mockGetRecent).toHaveBeenCalledWith('mock-token', 3);
    });

    test('searches the backend as the user types', async () => {
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        await userEvent.type(screen.getByTestId('instruction-picker-search'), 'tax');

        expect(await screen.findByText('H1B Tax Advisor')).toBeInTheDocument();
        expect(screen.getByText('Search results')).toBeInTheDocument();
        await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('mock-token', 'tax'));
    });

    test('signed-out users are asked to sign in instead of searching', async () => {
        mockAuth.isAuthenticated = false;
        mockAuth.isSignedOut = true;
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        await userEvent.type(screen.getByTestId('instruction-picker-search'), 'tax');

        expect(await screen.findByText('Sign in to search instructions.')).toBeInTheDocument();
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(mockSearch).not.toHaveBeenCalled();
    });

    test('signed-out users are asked to log in instead of loading recent instructions', async () => {
        mockAuth.isAuthenticated = false;
        mockAuth.isSignedOut = true;
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        expect(await screen.findByTestId('instruction-picker-log-in')).toHaveTextContent('Please log in first.');
        expect(screen.queryByText('Failed to load instructions. Please try again.')).not.toBeInTheDocument();
        expect(mockGetRecent).not.toHaveBeenCalled();
    });

    test('selecting a tile fires onSelect with the instruction', async () => {
        const onSelect = jest.fn();
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={onSelect} />);

        await userEvent.click(await screen.findByTestId('instruction-picker-tile-inst-1'));
        expect(onSelect).toHaveBeenCalledWith(recentInstruction);
    });

    test('renders nothing when closed', () => {
        render(<InstructionPickerModal isOpen={false} onClose={jest.fn()} onSelect={jest.fn()} />);
        expect(screen.queryByText('Choose Instruction')).not.toBeInTheDocument();
        expect(mockGetRecent).not.toHaveBeenCalled();
    });

    test('paints cached instructions instantly while refreshing in the background', () => {
        saveRecentInstructionsCache('cust-1', [recentInstruction]);
        // Keep the refresh pending: the cached tiles must show without a loading state
        mockGetRecent.mockReturnValue(new Promise(() => {}));

        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        expect(screen.getByText('Physics Wave Expert')).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    test('replaces the cached list once the refresh lands and mirrors it to the cache', async () => {
        saveRecentInstructionsCache('cust-1', [{ ...recentInstruction, id: 'stale-1', name: 'Stale Instruction' }]);
        mockGetRecent.mockResolvedValue({ instructions: [recentInstruction] });

        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        expect(await screen.findByText('Physics Wave Expert')).toBeInTheDocument();
        expect(screen.queryByText('Stale Instruction')).not.toBeInTheDocument();
        expect(loadRecentInstructionsCache('cust-1')).toEqual([recentInstruction]);
    });

    test('keeps showing the stale list when the background refresh fails', async () => {
        saveRecentInstructionsCache('cust-1', [recentInstruction]);
        mockGetRecent.mockRejectedValue(new Error('network down'));

        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        await waitFor(() => expect(mockGetRecent).toHaveBeenCalled());
        expect(screen.getByText('Physics Wave Expert')).toBeInTheDocument();
    });

    test('says when search is not set up and links to the Settings page for it', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        mockSearch.mockRejectedValue(new SearchError('409', 409, 'SEARCH_NOT_CONFIGURED', 'VECTOR_DB_NOT_CONFIGURED'));
        const onClose = jest.fn();
        render(
            <MemoryRouter>
                <InstructionPickerModal isOpen onClose={onClose} onSelect={jest.fn()} />
            </MemoryRouter>
        );

        await userEvent.type(screen.getByTestId('instruction-picker-search'), 'tax');

        const notice = await screen.findByTestId('instruction-picker-not-set-up');
        expect(notice).toHaveTextContent("Search isn't set up. Connect a vector DB to search.");
        expect(screen.queryByText('Failed to load instructions. Please try again.')).not.toBeInTheDocument();
        const link = screen.getByRole('link', { name: 'Open Settings' });
        expect(link).toHaveAttribute('href', '/settings/ai/vector-db');
        await userEvent.click(link);
        expect(onClose).toHaveBeenCalled();
    });

    test('a search that failed for another reason keeps the generic error', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        mockSearch.mockRejectedValue(new SearchError('502', 502, 'SEARCH_UNAVAILABLE'));
        render(<InstructionPickerModal isOpen onClose={jest.fn()} onSelect={jest.fn()} />);

        await userEvent.type(screen.getByTestId('instruction-picker-search'), 'tax');

        expect(await screen.findByText('Failed to load instructions. Please try again.')).toBeInTheDocument();
        expect(screen.queryByTestId('instruction-picker-not-set-up')).not.toBeInTheDocument();
    });
});
