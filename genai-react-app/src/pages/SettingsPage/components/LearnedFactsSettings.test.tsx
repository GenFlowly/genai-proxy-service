import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LearnedFactsSettings } from './LearnedFactsSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { deleteAllMemoryFacts } from '../../../services/learnedFactsService';
import {
    getAiPreferences,
    mergeAiPreferences,
    replaceAiPreferences,
} from '../../../stores/aiPreferencesStore';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/saveAIConfigService');
jest.mock('../../../services/learnedFactsService');
// Render the library button/modal as plain elements so they can be clicked
jest.mock('@genflowly/component-library', () => ({
    PillButton: ({ onClick, label, disabled }: any) => (
        <button onClick={onClick} disabled={disabled}>
            {label}
        </button>
    ),
    Modal: ({ isOpen, title, children }: any) =>
        isOpen ? (
            <div role="dialog" aria-label={title}>
                {children}
            </div>
        ) : null,
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockSave = saveAIConfigPreferences as jest.Mock;
const mockDeleteAll = deleteAllMemoryFacts as jest.Mock;

const chats = () => screen.getByTestId('learned-facts-memoryLearnFromChats') as HTMLInputElement;
const replies = () => screen.getByTestId('learned-facts-memoryUseInReplies') as HTMLInputElement;

describe('LearnedFactsSettings', () => {
    const showToast = jest.fn();
    const getAccessTokenSilently = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        replaceAiPreferences('CU-test', {});
        getAccessTokenSilently.mockResolvedValue('tok');
        mockUseAuth.mockReturnValue({ isAuthenticated: true, getAccessTokenSilently });
        mockUseToast.mockReturnValue({ showToast });
        // The real service writes the store on success; mirror that here
        mockSave.mockImplementation(async (_token: string, payload: any) => {
            mergeAiPreferences(payload.aiConfigPreferences);
        });
    });

    test('every switch is on when the user never changed one', () => {
        render(<LearnedFactsSettings />);

        expect(chats().checked).toBe(true);
        expect(replies().checked).toBe(true);
    });

    test('there is no notes switch, since no app saves notes', () => {
        render(<LearnedFactsSettings />);

        expect(screen.queryByTestId('learned-facts-memoryLearnFromNotes')).not.toBeInTheDocument();
    });

    test('shows the stored values', () => {
        act(() => {
            replaceAiPreferences('CU1', { memoryLearnFromChats: false, memoryUseInReplies: null });
        });

        render(<LearnedFactsSettings />);

        expect(chats().checked).toBe(false);
        expect(replies().checked).toBe(true);
    });

    test('turning a switch off saves only that switch', async () => {
        render(<LearnedFactsSettings />);

        await userEvent.click(replies());

        await waitFor(() =>
            expect(mockSave).toHaveBeenCalledWith('tok', {
                aiConfigPreferences: { memoryUseInReplies: false },
            })
        );
        await waitFor(() => expect(replies().checked).toBe(false));
        expect(replies()).not.toBeDisabled();
        expect(chats().checked).toBe(true);
        expect(getAiPreferences()?.memoryUseInReplies).toBe(false);
    });

    test('a failed save shows the error and puts the switch back', async () => {
        mockSave.mockRejectedValue(new Error('Network down'));
        render(<LearnedFactsSettings />);

        await userEvent.click(chats());

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Network down'));
        expect(chats().checked).toBe(true);
        expect(chats()).not.toBeDisabled();
    });

    test('a failed save without a message shows the generic error', async () => {
        mockSave.mockRejectedValue({});
        render(<LearnedFactsSettings />);

        await userEvent.click(replies());

        await waitFor(() =>
            expect(showToast).toHaveBeenCalledWith("Couldn't save the setting. Please try again.")
        );
    });

    test('asks to log in instead of saving when signed out', async () => {
        mockUseAuth.mockReturnValue({ isAuthenticated: false, getAccessTokenSilently });
        render(<LearnedFactsSettings />);

        await userEvent.click(chats());

        expect(showToast).toHaveBeenCalledWith('Please log in first.');
        expect(mockSave).not.toHaveBeenCalled();
    });

    test('deleting all learned facts asks first, then deletes and reports the count', async () => {
        mockDeleteAll.mockResolvedValue(4);
        render(<LearnedFactsSettings />);

        await userEvent.click(screen.getByText('Delete all learned facts'));
        const dialog = screen.getByRole('dialog', { name: 'Delete all learned facts?' });
        expect(dialog).toHaveTextContent("It can't be undone.");
        expect(mockDeleteAll).not.toHaveBeenCalled();

        await userEvent.click(screen.getByText('Delete all'));

        await waitFor(() => expect(mockDeleteAll).toHaveBeenCalledWith('tok'));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Deleted 4 learned facts.'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    test('a failed delete keeps the dialog open and says so', async () => {
        mockDeleteAll.mockRejectedValue(new Error('boom'));
        render(<LearnedFactsSettings />);

        await userEvent.click(screen.getByText('Delete all learned facts'));
        await userEvent.click(screen.getByText('Delete all'));

        await waitFor(() =>
            expect(showToast).toHaveBeenCalledWith("Couldn't delete learned facts. Please try again.")
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    test('cancel closes the dialog without deleting', async () => {
        render(<LearnedFactsSettings />);

        await userEvent.click(screen.getByText('Delete all learned facts'));
        await userEvent.click(screen.getByText('Cancel'));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mockDeleteAll).not.toHaveBeenCalled();
    });
});
