import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSidebar } from './SettingsSidebar';
import { useAuth } from '../../../context/AuthContext';

jest.mock('../../../context/AuthContext');

const mockUseAuth = useAuth as jest.Mock;

describe('SettingsSidebar', () => {
    const mockLogout = jest.fn();
    const mockOnTabChange = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseAuth.mockReturnValue({
            logout: mockLogout
        });
    });

    test('renders tabs and logout button', () => {
        render(<SettingsSidebar activeTab="profile" onTabChange={mockOnTabChange} />);
        
        expect(screen.getByText('Profile')).toBeInTheDocument();
        expect(screen.getByText('AI Settings')).toBeInTheDocument();
        expect(screen.getByText('Memory Settings')).toBeInTheDocument();
        expect(screen.getByText('Logout')).toBeInTheDocument();
    });

    test('calls onTabChange when clicking a tab', async () => {
        render(<SettingsSidebar activeTab="ai" onTabChange={mockOnTabChange} />);
        
        const profileTab = screen.getByText('Profile');
        await userEvent.click(profileTab);
        
        expect(mockOnTabChange).toHaveBeenCalledWith('profile');
    });

    test('calls logout when clicking logout button', async () => {
        render(<SettingsSidebar activeTab="profile" onTabChange={mockOnTabChange} />);
        
        const logoutButton = screen.getByText('Logout');
        await userEvent.click(logoutButton);
        
        expect(mockLogout).toHaveBeenCalledWith({ returnTo: window.location.origin });
    });
});
