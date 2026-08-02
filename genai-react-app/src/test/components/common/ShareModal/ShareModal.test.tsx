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
        
        const input = screen.getByPlaceholderText('Search exact username...');
        fireEvent.change(input, { target: { value: 'user1' } });
        
        mockSearchUserByUsername.mockResolvedValueOnce({ customerId: 'c1', username: 'user1', name: 'User One' });
        
        await waitFor(() => {
            expect(mockSearchUserByUsername).toHaveBeenCalledWith('mock-token', 'user1');
            expect(screen.getByText(/User One/)).toBeInTheDocument();
        });
        
        // Add user
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        
        expect(screen.getByText('Shared with:')).toBeInTheDocument();
        expect(screen.getByText('user1')).toBeInTheDocument();
    });

    it('calls onSave with selected mode and users', async () => {
        const handleSave = jest.fn();
        render(<ShareModal isOpen={true} onClose={jest.fn()} onSave={handleSave} />);
        
        fireEvent.click(screen.getByLabelText('Share with only some users'));
        
        const input = screen.getByPlaceholderText('Search exact username...');
        fireEvent.change(input, { target: { value: 'user1' } });
        
        mockSearchUserByUsername.mockResolvedValueOnce({ customerId: 'c1', username: 'user1' });
        
        await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled());
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        
        await waitFor(() => {
            expect(handleSave).toHaveBeenCalledWith('SPECIFIC', [{ customerId: 'c1', username: 'user1' }]);
        });
    });
});
