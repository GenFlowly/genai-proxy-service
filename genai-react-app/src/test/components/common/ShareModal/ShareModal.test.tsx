import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ShareModal from '../../../../components/common/ShareModal/ShareModal';
import { useAuth0 } from '@auth0/auth0-react';
import { searchUserByUsername } from '../../../../services/userService';
import { blockUser } from '../../../../services/moderationService';

jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn()
}));
jest.mock('../../../../services/userService');
jest.mock('../../../../services/moderationService', () => ({ blockUser: jest.fn() }));

const mockUseAuth0 = useAuth0 as jest.MockedFunction<typeof useAuth0>;
const mockSearchUserByUsername = searchUserByUsername as jest.MockedFunction<typeof searchUserByUsername>;
const mockBlockUser = blockUser as jest.Mock;

describe('ShareModal Component', () => {
    beforeEach(() => {
        mockUseAuth0.mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token'),
        } as any);
        mockSearchUserByUsername.mockResolvedValue(null);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('renders correctly and defaults to PRIVATE', () => {
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} />);
        expect(screen.getByText('Share Options')).toBeInTheDocument();
        expect(screen.getByLabelText('Not shared (Private)')).toBeChecked();
    });

    it('shows specific section and searches when Specific mode is selected', async () => {
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} />);
        fireEvent.click(screen.getByLabelText('Share with only some users'));
        
        const input = screen.getByPlaceholderText('Search username...');
        fireEvent.change(input, { target: { value: 'user1' } });
        
        mockSearchUserByUsername.mockResolvedValueOnce([{ customerId: 'c1', username: 'user1', name: 'User One' }]);
        
        await waitFor(() => {
            expect(mockSearchUserByUsername).toHaveBeenCalledWith('mock-token', 'user1');
            expect(screen.getByText(/User One/)).toBeInTheDocument();
        });
        
        // Add user
        fireEvent.click(screen.getByText('user1'));
        
        expect(screen.getByText('Shared with:')).toBeInTheDocument();
        expect(screen.getByText('user1')).toBeInTheDocument();
    });

    it('calls onSave with selected mode and users', async () => {
        const handleSave = jest.fn();
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={handleSave} />);
        
        fireEvent.click(screen.getByLabelText('Share with only some users'));
        
        const input = screen.getByPlaceholderText('Search username...');
        fireEvent.change(input, { target: { value: 'user1' } });
        
        mockSearchUserByUsername.mockResolvedValueOnce([{ customerId: 'c1', username: 'user1' }]);
        
        await waitFor(() => expect(screen.getByText('user1')).toBeInTheDocument());
        fireEvent.click(screen.getByText('user1'));
        
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        
        await waitFor(() => {
            expect(handleSave).toHaveBeenCalledWith('SPECIFIC', [{ customerId: 'c1', username: 'user1', role: 'VIEW' }], []);
        });
    });

    it('fetches shared users on load if entityId is provided', async () => {
        const fetchSharedUsers = jest.fn().mockResolvedValue([{ customerId: 'c2', username: 'user2', role: 'EDIT' }]);
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} entityId="inst-1" fetchSharedUsers={fetchSharedUsers} />);
        
        await waitFor(() => {
            expect(fetchSharedUsers).toHaveBeenCalledWith('inst-1');
            expect(screen.getByLabelText('Share with only some users')).toBeChecked();
            expect(screen.getByText('user2')).toBeInTheDocument();
        });
    });

    it('keeps what is being typed when the parent re-renders with a new fetchSharedUsers', async () => {
        // A phone keyboard resizes the page, and the parent passes a fresh inline function on every render
        const fetchSharedUsers = jest.fn().mockResolvedValue([]);
        const { rerender } = render(
            <ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} entityId="conv-1" fetchSharedUsers={id => fetchSharedUsers(id)} />
        );
        await waitFor(() => expect(screen.getByLabelText('Not shared (Private)')).toBeChecked());

        fireEvent.click(screen.getByLabelText('Share with only some users'));
        fireEvent.change(screen.getByPlaceholderText('Search username...'), { target: { value: 'ali' } });

        rerender(
            <ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} entityId="conv-1" fetchSharedUsers={id => fetchSharedUsers(id)} />
        );

        expect(fetchSharedUsers).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText('Share with only some users')).toBeChecked();
        expect(screen.getByPlaceholderText('Search username...')).toHaveValue('ali');
        await waitFor(() => expect(mockSearchUserByUsername).toHaveBeenCalledWith('mock-token', 'ali'));
    });

    it('removes initial users when saving', async () => {
        const fetchSharedUsers = jest.fn().mockResolvedValue([{ customerId: 'c2', username: 'user2', role: 'EDIT' }]);
        const handleSave = jest.fn();
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={handleSave} entityId="inst-1" fetchSharedUsers={fetchSharedUsers} />);
        
        await waitFor(() => expect(screen.getByText('user2')).toBeInTheDocument());
        
        // Remove user2
        fireEvent.click(screen.getByTestId('share-user-menu-c2'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
        expect(screen.queryByText('user2')).not.toBeInTheDocument();
        
        fireEvent.click(screen.getByLabelText('Not shared (Private)'));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        
        await waitFor(() => {
            // mode, finalUsers, removedUsers
            expect(handleSave).toHaveBeenCalledWith('PRIVATE', [], [{ customerId: 'c2', username: 'user2', role: 'EDIT' }]);
        });
    });

    it('handles role changes', async () => {
        const fetchSharedUsers = jest.fn().mockResolvedValue([{ customerId: 'c2', username: 'user2', role: 'VIEW' }]);
        const handleSave = jest.fn();
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={handleSave} entityId="inst-1" fetchSharedUsers={fetchSharedUsers} />);
        
        await waitFor(() => expect(screen.getByText('user2')).toBeInTheDocument());
        
        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'EDIT' } });
        
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(handleSave).toHaveBeenCalledWith('SPECIFIC', [{ customerId: 'c2', username: 'user2', role: 'EDIT' }], []);
        });
    });

    it('handles search user API failure gracefully', async () => {
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} />);
        fireEvent.click(screen.getByLabelText('Share with only some users'));
        
        const input = screen.getByPlaceholderText('Search username...');
        fireEvent.change(input, { target: { value: 'errorUser' } });
        
        mockSearchUserByUsername.mockRejectedValueOnce(new Error('API failed'));
        
        await waitFor(() => {
            expect(mockSearchUserByUsername).toHaveBeenCalled();
            expect(screen.queryByText('Searching...')).not.toBeInTheDocument();
        });
    });

    it('clears search results when search term is less than 3 chars', async () => {
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} />);
        fireEvent.click(screen.getByLabelText('Share with only some users'));
        
        const input = screen.getByPlaceholderText('Search username...');
        fireEvent.change(input, { target: { value: 'user1' } });
        mockSearchUserByUsername.mockResolvedValueOnce([{ customerId: 'c1', username: 'user1' }]);
        
        await waitFor(() => expect(screen.getByText('user1')).toBeInTheDocument());
        
        fireEvent.change(input, { target: { value: 'us' } });
        await waitFor(() => expect(screen.queryByText('user1')).not.toBeInTheDocument());
    });

    it('can select PUBLIC or PRIVATE', () => {
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} />);
        
        fireEvent.click(screen.getByLabelText('Make public to everyone'));
        expect(screen.getByLabelText('Make public to everyone')).toBeChecked();
        
        fireEvent.click(screen.getByLabelText('Not shared (Private)'));
        expect(screen.getByLabelText('Not shared (Private)')).toBeChecked();
    });

    it('shows role selector and saves correctly in PUBLIC mode', async () => {
        const handleSave = jest.fn();
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={handleSave} />);
        
        fireEvent.click(screen.getByLabelText('Make public to everyone'));
        
        const select = screen.getByRole('combobox');
        expect(select).toBeInTheDocument();
        
        fireEvent.change(select, { target: { value: 'EDIT' } });
        
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        
        await waitFor(() => {
            expect(handleSave).toHaveBeenCalledWith('PUBLIC', [{ customerId: 'PUBLIC', username: 'Public', role: 'EDIT' }], []);
        });
    });

    it('loads PUBLIC mode correctly when PUBLIC user is in fetched users', async () => {
        const fetchSharedUsers = jest.fn().mockResolvedValue([
            { customerId: 'PUBLIC', username: 'Public', role: 'EDIT' },
            { customerId: 'c2', username: 'user2', role: 'VIEW' }
        ]);
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} entityId="inst-1" fetchSharedUsers={fetchSharedUsers} />);
        
        await waitFor(() => {
            expect(fetchSharedUsers).toHaveBeenCalledWith('inst-1');
            expect(screen.getByLabelText('Make public to everyone')).toBeChecked();
            const select = screen.getByRole('combobox') as HTMLSelectElement;
            expect(select.value).toBe('EDIT');
        });
    });

    describe('blocking a recipient', () => {
        const user = { customerId: 'c2', username: 'mara', role: 'VIEW' as const };
        const open = async () => {
            render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} entityId="e1" fetchSharedUsers={jest.fn().mockResolvedValue([user])} />);
            fireEvent.click(await screen.findByTestId('share-user-menu-c2'));
        };

        beforeEach(() => {
            mockBlockUser.mockReset();
        });

        it('asks first, then blocks and drops the person from the list', async () => {
            mockBlockUser.mockResolvedValue(undefined);
            await open();
            fireEvent.click(screen.getByTestId('share-user-block-c2'));
            expect(mockBlockUser).not.toHaveBeenCalled();
            fireEvent.click(screen.getByTestId('share-block-confirm-button'));
            await waitFor(() => expect(mockBlockUser).toHaveBeenCalledWith('mock-token', 'c2'));
            expect(await screen.findByText('Blocked @mara.')).toBeInTheDocument();
            expect(screen.queryByTestId('share-user-menu-c2')).not.toBeInTheDocument();
        });

        it('keeps the person when the block fails', async () => {
            jest.spyOn(console, 'error').mockImplementation(() => undefined);
            mockBlockUser.mockRejectedValue(new Error('nope'));
            await open();
            fireEvent.click(screen.getByTestId('share-user-block-c2'));
            fireEvent.click(screen.getByTestId('share-block-confirm-button'));
            expect(await screen.findByText("Couldn't block @mara. Please try again.")).toBeInTheDocument();
            expect(screen.getByTestId('share-user-menu-c2')).toBeInTheDocument();
        });

        it('can back out of the block and can still remove someone from the menu', async () => {
            await open();
            fireEvent.click(screen.getByTestId('share-user-block-c2'));
            fireEvent.click(screen.getAllByText('Cancel')[0]);
            expect(screen.queryByTestId('share-block-confirm')).not.toBeInTheDocument();
            fireEvent.click(screen.getByTestId('share-user-menu-c2'));
            fireEvent.click(screen.getByText('Remove'));
            expect(screen.queryByTestId('share-user-menu-c2')).not.toBeInTheDocument();
        });
    });

    it('links the content rules', () => {
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={jest.fn()} />);
        expect(screen.getByRole('link', { name: 'content rules' })).toHaveAttribute('href', '/content-rules');
    });
});
