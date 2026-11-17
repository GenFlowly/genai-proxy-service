import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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

jest.mock('../../../components/common/BlockedUsersList/BlockedUsersList', () => ({
    BlockedUsersList: () => <div data-testid="blocked-users-list" />,
}));
const mockBreakpoints = jest.fn();
jest.mock('../../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }));

const mockUseAuth = useAuth as jest.Mock;
const mockGetUserProfile = getUserProfile as jest.Mock;
const mockUpdateUsername = updateUsername as jest.Mock;
const mockUpdateDiscoverability = updateDiscoverability as jest.Mock;

describe('ProfileSettings', () => {
    const mockGetAccessTokenSilently = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockBreakpoints.mockReturnValue({ isNarrow: false });
        mockGetAccessTokenSilently.mockResolvedValue('test-token');
        mockUseAuth.mockReturnValue({
            getAccessTokenSilently: mockGetAccessTokenSilently,
            isAuthenticated: true,
            customerId: 'cust-1',
        });
    });

    const profile = { customerId: 'cust-1', username: 'u', isDiscoverable: false };

    test('desktop: Blocked users is listed in place', async () => {
        mockGetUserProfile.mockResolvedValue(profile);
        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        expect(await screen.findByTestId('blocked-users-list')).toBeInTheDocument();
    });

    test('phone: Blocked users links to its own page', async () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true });
        mockGetUserProfile.mockResolvedValue(profile);
        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        expect(await screen.findByTestId('blocked-users-link')).toHaveAttribute('href', '/blocked-users');
        expect(screen.queryByTestId('blocked-users-list')).not.toBeInTheDocument();
    });

    test('renders loading state initially', () => {
        mockGetUserProfile.mockReturnValue(new Promise(() => {})); // pending promise
        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        expect(screen.getByText('Loading profile...')).toBeInTheDocument();
    });

    test('renders error state when profile fails to load', async () => {
        mockGetUserProfile.mockRejectedValue(new Error('Failed'));
        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
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

        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        
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

        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        
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

        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        
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

        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        
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

        render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));
        
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

    describe('AI data sharing', () => {
        const profile = { username: 'ada', email: 'ada@example.com', name: 'Ada', isDiscoverable: false };

        test('shows what is shared, when the customer agreed, and where to manage services', async () => {
            mockGetUserProfile.mockResolvedValue(profile);
            mockUseAuth.mockReturnValue({
                getAccessTokenSilently: mockGetAccessTokenSilently,
                isAuthenticated: true,
                customerId: 'cust-1',
                aiDataConsentAt: '2026-11-08T21:00:00Z',
            });

            render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));

            expect(await screen.findByTestId('ai-data-sharing')).toBeInTheDocument();
            expect(screen.getByText('AI model providers')).toBeInTheDocument();
            expect(screen.getByText(/You agreed on/)).toBeInTheDocument();
            expect(screen.getByRole('link', { name: 'Manage your connected services' }))
                .toHaveAttribute('href', '/settings/ai/llm-keys');
        });

        test('leaves out the date when there is none', async () => {
            mockGetUserProfile.mockResolvedValue(profile);

            render(withQueryClient(<MemoryRouter><ProfileSettings /></MemoryRouter>));

            expect(await screen.findByTestId('ai-data-sharing')).toBeInTheDocument();
            expect(screen.queryByText(/You agreed on/)).not.toBeInTheDocument();
        });
    });
});
