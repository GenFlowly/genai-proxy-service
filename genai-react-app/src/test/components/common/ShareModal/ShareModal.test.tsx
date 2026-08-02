import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ShareModal from '../../../../components/common/ShareModal/ShareModal';
import { useAuth0 } from '@auth0/auth0-react';
import { searchUserByUsername } from '../../../../services/userService';

jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn()
}));
jest.mock('../../../../services/userService');

const mockUseAuth0 = useAuth0 as jest.MockedFunction<typeof useAuth0>;
const mockSearchUserByUsername = searchUserByUsername as jest.MockedFunction<typeof searchUserByUsername>;

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

    it('removes initial users when saving', async () => {
        const fetchSharedUsers = jest.fn().mockResolvedValue([{ customerId: 'c2', username: 'user2', role: 'EDIT' }]);
        const handleSave = jest.fn();
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={handleSave} entityId="inst-1" fetchSharedUsers={fetchSharedUsers} />);
        
        await waitFor(() => expect(screen.getByText('user2')).toBeInTheDocument());
        
        // Remove user2
        const removeButtons = screen.getAllByRole('button', { name: '×' });
        fireEvent.click(removeButtons[1]);
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
});
