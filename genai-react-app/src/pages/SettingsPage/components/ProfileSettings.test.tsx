import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileSettings } from './ProfileSettings';
import { useAuth } from '../../../context/AuthContext';
import { getUserProfile, updateUsername, updateDiscoverability } from '../../../services/userService';
import { withQueryClient } from '../../../test/utils/queryWrapper';

jest.mock('../../../context/AuthContext');
jest.mock('../../../services/userService');
// The delete section has its own test suite
jest.mock('./DeleteDataSettings', () => ({
    DeleteDataSettings: () => <div data-testid="delete-data-section" />,
}));

const mockUseAuth = useAuth as jest.Mock;
const mockGetUserProfile = getUserProfile as jest.Mock;
const mockUpdateUsername = updateUsername as jest.Mock;
const mockUpdateDiscoverability = updateDiscoverability as jest.Mock;

describe('ProfileSettings', () => {
    const mockGetAccessTokenSilently = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockUseAuth.mockReturnValue({
            getAccessTokenSilently: mockGetAccessTokenSilently,
            isAuthenticated: true,
            customerId: 'cust-1',
        });
    });

    test('renders loading state initially', () => {
        mockGetUserProfile.mockReturnValue(new Promise(() => {})); // pending promise
        render(withQueryClient(<ProfileSettings />));
        expect(screen.getByText('Loading profile...')).toBeInTheDocument();
    });

    test('renders error state when profile fails to load', async () => {
        mockGetUserProfile.mockRejectedValue(new Error('Failed'));
        render(withQueryClient(<ProfileSettings />));
        await waitFor(() => {
            expect(screen.getByText('Failed to load profile data.')).toBeInTheDocument();
        });
    });

    test('renders profile successfully', async () => {
        mockGetUserProfile.mockResolvedValue({
            username: 'johndoe',
            isDiscoverable: true,
            name: 'John Doe',
            email: 'john@example.com',
            picture: 'http://example.com/pic.jpg'
        });

        render(withQueryClient(<ProfileSettings />));
        
        await waitFor(() => {
            expect(screen.getByText('Personal Details')).toBeInTheDocument();
        });

        expect(screen.getByDisplayValue('johndoe')).toBeInTheDocument();
        expect(screen.getByText('John Doe')).toBeInTheDocument();
        expect(screen.getByText('john@example.com')).toBeInTheDocument();
        expect(screen.getByRole('checkbox')).toBeChecked();
        expect(screen.getByTestId('delete-data-section')).toBeInTheDocument();
    });

    test('updates username successfully', async () => {
        mockGetUserProfile.mockResolvedValue({
            username: 'johndoe',
            isDiscoverable: true,
            name: 'John Doe'
        });
        mockUpdateUsername.mockResolvedValue(undefined);

        render(withQueryClient(<ProfileSettings />));
        
        await waitFor(() => {
            expect(screen.getByText('Personal Details')).toBeInTheDocument();
        });

        const usernameInput = screen.getByDisplayValue('johndoe');
        
        await userEvent.clear(usernameInput);
        await userEvent.type(usernameInput, 'newusername');
        
        const updateButton = screen.getByRole('button', { name: /update username/i });
        await userEvent.click(updateButton);

        await waitFor(() => {
            expect(mockUpdateUsername).toHaveBeenCalledWith('test-token', 'newusername');
            expect(screen.getByText('Username updated successfully!')).toBeInTheDocument();
        });
    });

    test('handles username update error', async () => {
        mockGetUserProfile.mockResolvedValue({
            username: 'johndoe',
            isDiscoverable: true
        });
        mockUpdateUsername.mockRejectedValue(new Error('Username taken'));

        render(withQueryClient(<ProfileSettings />));
        
        await waitFor(() => {
            expect(screen.getByText('Personal Details')).toBeInTheDocument();
        });

        const usernameInput = screen.getByDisplayValue('johndoe');
        
        await userEvent.clear(usernameInput);
        await userEvent.type(usernameInput, 'takenusername');
        
        const updateButton = screen.getByRole('button', { name: /update username/i });
        await userEvent.click(updateButton);

        await waitFor(() => {
            expect(screen.getByText('Username taken')).toBeInTheDocument();
            // Input should revert on error
            expect(screen.getByDisplayValue('johndoe')).toBeInTheDocument();
        });
    });

    test('toggles discoverability successfully', async () => {
        mockGetUserProfile.mockResolvedValue({
            username: 'johndoe',
            isDiscoverable: false
        });
        mockUpdateDiscoverability.mockResolvedValue(true);

        render(withQueryClient(<ProfileSettings />));
        
        await waitFor(() => {
            expect(screen.getByText('Personal Details')).toBeInTheDocument();
        });

        const checkbox = screen.getByRole('checkbox');
        
        expect(checkbox).not.toBeChecked();
        await userEvent.click(checkbox);

        await waitFor(() => {
            expect(mockUpdateDiscoverability).toHaveBeenCalledWith('test-token', true);
            expect(checkbox).toBeChecked();
        });
    });

    test('handles discoverability toggle error', async () => {
        mockGetUserProfile.mockResolvedValue({
            username: 'johndoe',
            isDiscoverable: false
        });
        mockUpdateDiscoverability.mockResolvedValue(false); // indicates failure

        render(withQueryClient(<ProfileSettings />));
        
        await waitFor(() => {
            expect(screen.getByText('Personal Details')).toBeInTheDocument();
        });

        const checkbox = screen.getByRole('checkbox');
        
        await userEvent.click(checkbox);

        await waitFor(() => {
            expect(screen.getByText('Failed to update discoverability')).toBeInTheDocument();
            // Should revert
            expect(checkbox).not.toBeChecked();
        });
    });
});
