import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { NavbarMenu, NAV_ITEMS } from '../../../../components/widgets/NavbarMenuWidget/NavbarMenu';
import '@testing-library/jest-dom';

describe('NavbarMenu Component', () => {
    test('renders all navigation items', () => {
        render(
            <MemoryRouter initialEntries={['/']}>
                <NavbarMenu />
            </MemoryRouter>
        );

        NAV_ITEMS.forEach(item => {
            const linkElement = screen.getByTestId(`navbar-item-${item.id}`);
            expect(linkElement).toBeInTheDocument();
            expect(linkElement).toHaveTextContent(item.label);
            expect(linkElement).toHaveAttribute('href', item.path);
        });
    });

    test('applies active class to current route', () => {
        render(
            <MemoryRouter initialEntries={['/memory']}>
                <NavbarMenu />
            </MemoryRouter>
        );

        const memoryLink = screen.getByTestId('navbar-item-memory');
        expect(memoryLink.className).toMatch(/activeNavLink/);

        const chatLink = screen.getByTestId('navbar-item-chat');
        expect(chatLink.className).not.toMatch(/activeNavLink/);
    });

    test('navigates to correct route on click', async () => {
        const LocationDisplay = () => {
            const location = useLocation();
            return <div data-testid="location-display">{location.pathname}</div>;
        };

        render(
            <MemoryRouter initialEntries={['/chat']}>
                <NavbarMenu />
                <Routes>
                    <Route path="*" element={<LocationDisplay />} />
                </Routes>
            </MemoryRouter>
        );

        // Verify initial route
        expect(screen.getByTestId('location-display')).toHaveTextContent('/');

        // Click Memory link
        const memoryLink = screen.getByTestId('navbar-item-memory');
        await userEvent.click(memoryLink);

        // Verify route changed
        expect(screen.getByTestId('location-display')).toHaveTextContent('/memory');

        // Active class should have updated
        expect(memoryLink.className).toMatch(/activeNavLink/);
    });
});
