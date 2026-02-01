import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PromptEditorTooltip from '../../../../components/widgets/PromptEditorWidget/PromptEditorTooltip';
import styles from '../../../../../components/widgets/PromptEditorWidget/PromptEditorTooltip.module.scss';
import '@testing-library/jest-dom';

describe('PromptEditorTooltip', () => {
    test('does not render when not visible', () => {
        render(
            <PromptEditorTooltip
                top={100}
                left={100}
                visible={false}
                onMarkReusable={jest.fn()}
            />
        );
        expect(screen.queryByText('Mark as Reusable')).not.toBeInTheDocument();
    });

    test('renders when visible', () => {
        render(
            <PromptEditorTooltip
                top={100}
                left={100}
                visible={true}
                onMarkReusable={jest.fn()}
            />
        );
        expect(screen.getByText('Mark as Reusable')).toBeInTheDocument();
    });

    test('calls onMarkReusable when clicked', () => {
        const handleMark = jest.fn();
        render(
            <PromptEditorTooltip
                top={100}
                left={100}
                visible={true}
                onMarkReusable={handleMark}
            />
        );

        fireEvent.click(screen.getByText('Mark as Reusable'));
        expect(handleMark).toHaveBeenCalled();
    });

    test('renders at correct position', () => {
        const { container } = render(
            <PromptEditorTooltip
                top={200}
                left={150}
                visible={true}
                onMarkReusable={jest.fn()}
            />
        );

        // Since it's a portal, we look at the body's last child usually, but testing-library finds it by text.
        // We can check style.
        const tooltip = screen.getByText('Mark as Reusable').parentElement;
        expect(tooltip).toHaveStyle({ top: '190px', left: '150px' });
    });

    test('prevents default on mouse down to avoid focus theft', () => {
        render(
            <PromptEditorTooltip
                top={100}
                left={100}
                visible={true}
                onMarkReusable={jest.fn()}
            />
        );

        const tooltipContainer = screen.getByText('Mark as Reusable').closest('div');
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        Object.assign(event, { preventDefault: jest.fn() });

        fireEvent(tooltipContainer!, event);

        expect(event.preventDefault).toHaveBeenCalled();
    });
});
