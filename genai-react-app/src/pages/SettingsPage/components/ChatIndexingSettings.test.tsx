import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatIndexingSettings } from './ChatIndexingSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { deleteIndexedChats } from '../../../services/chatIndexingService';
import { getAiPreferences, mergeAiPreferences, replaceAiPreferences } from '../../../stores/aiPreferencesStore';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/saveAIConfigService');
jest.mock('../../../services/chatIndexingService');
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
const mockDelete = deleteIndexedChats as jest.Mock;

const indexSwitch = () => screen.getByTestId('chat-indexing-switch') as HTMLInputElement;

describe('ChatIndexingSettings', () => {
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
        mockDelete.mockResolvedValue(5);
    });

    const indexingOn = () => act(() => replaceAiPreferences('CU1', { indexChats: true }));

    test('indexing is off until the user turns it on', () => {
        render(<ChatIndexingSettings />);

        expect(indexSwitch().checked).toBe(false);
    });

    test('turning it on saves the setting straight away', async () => {
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        await waitFor(() =>
            expect(mockSave).toHaveBeenCalledWith('tok', { aiConfigPreferences: { indexChats: true } })
        );
        await waitFor(() => expect(indexSwitch().checked).toBe(true));
        expect(getAiPreferences()?.indexChats).toBe(true);
    });

    test('turning it off asks first, and "Stop indexing" keeps the indexed chats', async () => {
        indexingOn();
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());
        expect(screen.getByRole('dialog', { name: 'Stop indexing your chats?' })).toBeInTheDocument();
        expect(mockSave).not.toHaveBeenCalled();

        await userEvent.click(screen.getByText('Stop indexing'));

        await waitFor(() =>
            expect(mockSave).toHaveBeenCalledWith('tok', { aiConfigPreferences: { indexChats: false } })
        );
        expect(mockDelete).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(indexSwitch().checked).toBe(false);
    });

    test('"Stop and delete" also deletes the indexed chats', async () => {
        indexingOn();
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());
        await userEvent.click(screen.getByText('Stop and delete'));

        await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('tok'));
        expect(mockSave).toHaveBeenCalledWith('tok', { aiConfigPreferences: { indexChats: false } });
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Indexed chats deleted.'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    test('cancelling the turn-off changes nothing', async () => {
        indexingOn();
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());
        await userEvent.click(screen.getByText('Cancel'));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mockSave).not.toHaveBeenCalled();
        expect(indexSwitch().checked).toBe(true);
    });

    test('a failed save shows the error, keeps the dialog and puts the switch back', async () => {
        indexingOn();
        mockSave.mockRejectedValue(new Error('Network down'));
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());
        await userEvent.click(screen.getByText('Stop and delete'));

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Network down'));
        expect(mockDelete).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(indexSwitch().checked).toBe(true);
    });

    test('a failed save without a message shows the generic error', async () => {
        mockSave.mockRejectedValue({});
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        await waitFor(() =>
            expect(showToast).toHaveBeenCalledWith("Couldn't save the setting. Please try again.")
        );
        expect(indexSwitch().checked).toBe(false);
    });

    test('asks to log in instead of saving when signed out', async () => {
        mockUseAuth.mockReturnValue({ isAuthenticated: false, getAccessTokenSilently });
        render(<ChatIndexingSettings />);

        await userEvent.click(indexSwitch());

        expect(showToast).toHaveBeenCalledWith('Please log in first.');
        expect(mockSave).not.toHaveBeenCalled();
    });

    test('"Delete indexed chats" asks first, then deletes', async () => {
        render(<ChatIndexingSettings />);

        await userEvent.click(screen.getByText('Delete indexed chats'));
        expect(screen.getByRole('dialog', { name: 'Delete indexed chats?' })).toHaveTextContent(
            'Your conversations stay in your history.'
        );
        expect(mockDelete).not.toHaveBeenCalled();

        await userEvent.click(screen.getByText('Delete'));

        await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('tok'));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Indexed chats deleted.'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    test('a failed delete keeps the dialog open and says so', async () => {
        mockDelete.mockRejectedValue(new Error('boom'));
        render(<ChatIndexingSettings />);

        await userEvent.click(screen.getByText('Delete indexed chats'));
        await userEvent.click(screen.getByText('Delete'));

        await waitFor(() =>
            expect(showToast).toHaveBeenCalledWith("Couldn't delete indexed chats. Please try again.")
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    test('cancelling the delete closes the dialog without deleting', async () => {
        render(<ChatIndexingSettings />);

        await userEvent.click(screen.getByText('Delete indexed chats'));
        await userEvent.click(screen.getByText('Cancel'));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mockDelete).not.toHaveBeenCalled();
    });
});
