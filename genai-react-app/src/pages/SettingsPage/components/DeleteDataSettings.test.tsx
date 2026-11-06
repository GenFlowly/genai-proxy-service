import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteDataSettings } from './DeleteDataSettings';
import { useAuth } from '../../../context/AuthContext';
import { deleteAccount, deleteAllCredentials } from '../../../services/accountService';

jest.mock('../../../context/AuthContext');
jest.mock('../../../services/accountService', () => ({
    ...jest.requireActual('../../../services/accountService'),
    deleteAccount: jest.fn(),
    deleteAllCredentials: jest.fn(),
}));
// Plain elements so the buttons and dialogs can be driven directly
jest.mock('@genflowly/component-library', () => ({
    PillButton: ({ onClick, label, disabled, 'data-testid': testId }: any) => (
        <button onClick={onClick} disabled={disabled} data-testid={testId}>
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
const mockDeleteAccount = deleteAccount as jest.Mock;
const mockDeleteAllCredentials = deleteAllCredentials as jest.Mock;

describe('DeleteDataSettings', () => {
    const getAccessTokenSilently = jest.fn();
    const logout = jest.fn();
    const resyncAccount = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        getAccessTokenSilently.mockResolvedValue('tok');
        mockUseAuth.mockReturnValue({ isAuthenticated: true, getAccessTokenSilently, logout, resyncAccount });
    });

    describe('delete all API keys', () => {
        test('asks first, then deletes, refreshes the key statuses and reports the count', async () => {
            mockDeleteAllCredentials.mockResolvedValue(3);
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            expect(screen.getByRole('dialog', { name: 'Delete all API keys?' })).toBeInTheDocument();
            expect(mockDeleteAllCredentials).not.toHaveBeenCalled();

            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            await waitFor(() => expect(screen.getByTestId('delete-data-notice')).toHaveTextContent('Deleted 3 keys.'));
            expect(mockDeleteAllCredentials).toHaveBeenCalledWith('tok');
            expect(resyncAccount).toHaveBeenCalled();
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        });

        test('says so when there was nothing to delete', async () => {
            mockDeleteAllCredentials.mockResolvedValue(0);
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            await waitFor(() =>
                expect(screen.getByTestId('delete-data-notice')).toHaveTextContent('There were no keys to delete.')
            );
        });

        test('a failure keeps the dialog open with an error', async () => {
            mockDeleteAllCredentials.mockRejectedValue(new Error('boom'));
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            await waitFor(() =>
                expect(screen.getByRole('alert')).toHaveTextContent("Couldn't delete your keys. Please try again.")
            );
            expect(screen.getByRole('dialog')).toBeInTheDocument();
            expect(resyncAccount).not.toHaveBeenCalled();
        });

        test('cancel closes the dialog without deleting', async () => {
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByText('Cancel'));

            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(mockDeleteAllCredentials).not.toHaveBeenCalled();
        });

        test('signed out, nothing is deleted', async () => {
            mockUseAuth.mockReturnValue({ isAuthenticated: false, getAccessTokenSilently, logout, resyncAccount });
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-keys-button'));
            await userEvent.click(screen.getByTestId('delete-keys-confirm'));

            expect(screen.getByRole('alert')).toHaveTextContent('Please log in first.');
            expect(mockDeleteAllCredentials).not.toHaveBeenCalled();
        });
    });

    describe('delete account', () => {
        test('lists what is deleted and needs DELETE typed before it can run', async () => {
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-account-button'));
            const dialog = screen.getByRole('dialog', { name: 'Delete your account?' });
            expect(dialog).toHaveTextContent('Your conversations, including shared ones. Their links stop working.');
            expect(dialog).toHaveTextContent("This can't be undone.");
            expect(screen.getByTestId('delete-account-confirm')).toBeDisabled();

            await userEvent.type(screen.getByTestId('delete-account-input'), 'delete');
            expect(screen.getByTestId('delete-account-confirm')).toBeDisabled();

            await userEvent.clear(screen.getByTestId('delete-account-input'));
            await userEvent.type(screen.getByTestId('delete-account-input'), 'DELETE');
            expect(screen.getByTestId('delete-account-confirm')).toBeEnabled();
            expect(mockDeleteAccount).not.toHaveBeenCalled();
        });

        test('a confirmed deletion signs the user out', async () => {
            mockDeleteAccount.mockResolvedValue(undefined);
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-account-button'));
            await userEvent.type(screen.getByTestId('delete-account-input'), 'DELETE');
            await userEvent.click(screen.getByTestId('delete-account-confirm'));

            await waitFor(() => expect(logout).toHaveBeenCalledWith({ returnTo: window.location.origin }));
            expect(mockDeleteAccount).toHaveBeenCalledWith('tok');
        });

        test('a failure keeps the user signed in with an error', async () => {
            mockDeleteAccount.mockRejectedValue(new Error('boom'));
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-account-button'));
            await userEvent.type(screen.getByTestId('delete-account-input'), 'DELETE');
            await userEvent.click(screen.getByTestId('delete-account-confirm'));

            await waitFor(() =>
                expect(screen.getByRole('alert')).toHaveTextContent("Couldn't delete your account. Please try again.")
            );
            expect(logout).not.toHaveBeenCalled();
            expect(screen.getByTestId('delete-account-confirm')).toBeEnabled();
        });

        test('signed out, nothing is deleted', async () => {
            mockUseAuth.mockReturnValue({ isAuthenticated: false, getAccessTokenSilently, logout, resyncAccount });
            render(<DeleteDataSettings />);

            await userEvent.click(screen.getByTestId('delete-account-button'));
            await userEvent.type(screen.getByTestId('delete-account-input'), 'DELETE');
            await userEvent.click(screen.getByTestId('delete-account-confirm'));

            expect(screen.getByRole('alert')).toHaveTextContent('Please log in first.');
            expect(mockDeleteAccount).not.toHaveBeenCalled();
        });
    });
});
