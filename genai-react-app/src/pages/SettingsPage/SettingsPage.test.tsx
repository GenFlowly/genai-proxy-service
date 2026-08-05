import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from './SettingsPage';

// Mocks
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('./components/ProfileSettings', () => ({ ProfileSettings: () => <div data-testid="profile-settings">Profile Settings</div> }));
jest.mock('./components/AISettings', () => ({ AISettings: () => <div data-testid="ai-settings">AI Settings</div> }));
jest.mock('./components/MemorySettings', () => ({ MemorySettings: () => <div data-testid="memory-settings">Memory Settings</div> }));

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        logout: jest.fn()
    })
}));

describe('SettingsPage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders correctly and defaults to profile tab', () => {
        render(
            <MemoryRouter>
                <SettingsPage />
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.getByText('Settings')).toBeInTheDocument(); // Sidebar header
        expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
        expect(screen.queryByTestId('ai-settings')).not.toBeInTheDocument();
    });

    test('switches tabs correctly', () => {
        render(
            <MemoryRouter>
                <SettingsPage />
            </MemoryRouter>
        );

        // Click AI Settings tab
        fireEvent.click(screen.getByText('AI Settings'));
        expect(screen.getByTestId('ai-settings')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-settings')).not.toBeInTheDocument();

        // Click Memory Settings tab
        fireEvent.click(screen.getByText('Memory Settings'));
        expect(screen.getByTestId('memory-settings')).toBeInTheDocument();
        expect(screen.queryByTestId('ai-settings')).not.toBeInTheDocument();
    });
});
