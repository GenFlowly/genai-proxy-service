import React from 'react';
import { render, screen } from '@testing-library/react';
import { Icon } from '../../../../components/common/Icon/Icon';
import '@testing-library/jest-dom';

describe('Icon Component', () => {
    const TEST_ICON_SRC = 'test-icon.svg';

    test('renders with correct styles and attributes', () => {
        render(<Icon src={TEST_ICON_SRC} size={24} alt="Test Icon" data-testid="test-icon" />);
        const icon = screen.getByTestId('test-icon');

        expect(icon).toBeInTheDocument();
        expect(icon).toHaveStyle({
            width: '24px',
            height: '24px',
            backgroundColor: 'currentColor'
        });

        expect(icon.style.maskImage).toContain(`url(${TEST_ICON_SRC})`);

        expect(icon).toHaveAttribute('aria-label', 'Test Icon');
        expect(icon).toHaveAttribute('role', 'img');
    });

    test('renders with default size and alt', () => {
        render(<Icon src={TEST_ICON_SRC} data-testid="default-icon" />);
        const icon = screen.getByTestId('default-icon');

        expect(icon).toHaveStyle({ width: '1em', height: '1em' });
        expect(icon).toHaveAttribute('aria-label', 'icon');
    });

    test('applies custom className', () => {
        render(<Icon src={TEST_ICON_SRC} className="custom-class" data-testid="styled-icon" />);
        const icon = screen.getByTestId('styled-icon');
        expect(icon).toHaveClass('custom-class');
    });
});
