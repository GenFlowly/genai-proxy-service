import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Breadcrumbs from '../../../../components/common/Breadcrumbs/Breadcrumbs';
import '@testing-library/jest-dom';

describe('Breadcrumbs', () => {
    test('renders all items with separators between them', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Menu', onClick: jest.fn() },
                    { label: 'Settings', onClick: jest.fn() },
                    { label: 'Profile', onClick: jest.fn() },
                ]}
            />
        );

        expect(screen.getByTestId('breadcrumbs')).toBeInTheDocument();
        expect(screen.getByText('Menu')).toBeInTheDocument();
        expect(screen.getByText('Settings')).toBeInTheDocument();
        expect(screen.getByText('Profile')).toBeInTheDocument();
        expect(screen.getAllByText('›')).toHaveLength(2);
    });

    test('every item with onClick is clickable', () => {
        const onMenu = jest.fn();
        const onSettings = jest.fn();
        const onProfile = jest.fn();
        render(
            <Breadcrumbs
                items={[
                    { label: 'Menu', onClick: onMenu },
                    { label: 'Settings', onClick: onSettings },
                    { label: 'Profile', onClick: onProfile },
                ]}
            />
        );

        fireEvent.click(screen.getByTestId('breadcrumb-Menu'));
        fireEvent.click(screen.getByTestId('breadcrumb-Settings'));
        fireEvent.click(screen.getByTestId('breadcrumb-Profile'));

        expect(onMenu).toHaveBeenCalled();
        expect(onSettings).toHaveBeenCalled();
        expect(onProfile).toHaveBeenCalled();
    });

    test('marks the last item as the current level', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Menu', onClick: jest.fn() },
                    { label: 'Profile', onClick: jest.fn() },
                ]}
            />
        );

        expect(screen.getByTestId('breadcrumb-Profile')).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('breadcrumb-Menu')).not.toHaveAttribute('aria-current');
    });

    test('items without onClick render as plain text, not buttons', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Menu', onClick: jest.fn() },
                    { label: 'Static' },
                ]}
            />
        );

        expect(screen.getByTestId('breadcrumb-Static').tagName).not.toBe('BUTTON');
        expect(screen.getByTestId('breadcrumb-Menu').tagName).toBe('BUTTON');
    });
});
