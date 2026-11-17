import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LearnedFactsSettings } from './LearnedFactsSettings';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService';
import { getAiPreferences, mergeAiPreferences, replaceAiPreferences } from '../../../stores/aiPreferencesStore';
import { renderSettingsPage } from '../settingsTestUtils';

jest.mock('../../../context/AuthContext');
jest.mock('../../../context/ToastContext');
jest.mock('../../../services/saveAIConfigService');

const mockUseAuth = useAuth as jest.Mock;
const mockUseToast = useToast as jest.Mock;
const mockSave = saveAIConfigPreferences as jest.Mock;

const chats = () => screen.getByTestId('learned-facts-memoryLearnFromChats');
const replies = () => screen.getByTestId('learned-facts-memoryUseInReplies');

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

    test('shows the page frame, "Learning on" and both switches on when nothing was changed', () => {
        renderSettingsPage(<LearnedFactsSettings />);

        expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
        expect(screen.getAllByText('Learning on').length).toBeGreaterThan(0);
        expect(screen.getByText('What it learns')).toBeInTheDocument();
        expect(chats()).toHaveAttribute('aria-checked', 'true');
        expect(replies()).toHaveAttribute('aria-checked', 'true');
    });

    test('there is no notes switch and no delete button; deleting lives on Delete your data', () => {
        renderSettingsPage(<LearnedFactsSettings />);

        expect(screen.queryByTestId('learned-facts-memoryLearnFromNotes')).not.toBeInTheDocument();
        expect(screen.queryByText(/delete/i)).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Open Memory' })).toHaveAttribute('href', '/memory');
    });

    test('shows the stored values and "Learning off"', () => {
        act(() => {
            replaceAiPreferences('CU1', { memoryLearnFromChats: false, memoryUseInReplies: null });
        });

        renderSettingsPage(<LearnedFactsSettings />);

        expect(chats()).toHaveAttribute('aria-checked', 'false');
        expect(replies()).toHaveAttribute('aria-checked', 'true');
        expect(screen.getAllByText('Learning off').length).toBeGreaterThan(0);
    });

    test('turning a switch off saves only that switch', async () => {
        renderSettingsPage(<LearnedFactsSettings />);

        await userEvent.click(replies());

        await waitFor(() =>
            expect(mockSave).toHaveBeenCalledWith('tok', { aiConfigPreferences: { memoryUseInReplies: false } })
        );
        await waitFor(() => expect(replies()).toHaveAttribute('aria-checked', 'false'));
        expect(replies()).not.toBeDisabled();
        expect(chats()).toHaveAttribute('aria-checked', 'true');
        expect(getAiPreferences()?.memoryUseInReplies).toBe(false);
    });

    test('a failed save shows the error and puts the switch back', async () => {
        mockSave.mockRejectedValue(new Error('Network down'));
        renderSettingsPage(<LearnedFactsSettings />);

        await userEvent.click(chats());

        await waitFor(() => expect(showToast).toHaveBeenCalledWith('Network down'));
        expect(chats()).toHaveAttribute('aria-checked', 'true');
        expect(chats()).not.toBeDisabled();
    });

    test('a failed save without a message shows the generic error', async () => {
        mockSave.mockRejectedValue({});
        renderSettingsPage(<LearnedFactsSettings />);

        await userEvent.click(replies());

        await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't save the setting. Please try again."));
    });

    test('asks to log in instead of saving when signed out', async () => {
        mockUseAuth.mockReturnValue({ isAuthenticated: false, getAccessTokenSilently });
        renderSettingsPage(<LearnedFactsSettings />);

        await userEvent.click(chats());

        expect(showToast).toHaveBeenCalledWith('Please log in first.');
        expect(mockSave).not.toHaveBeenCalled();
    });
});
