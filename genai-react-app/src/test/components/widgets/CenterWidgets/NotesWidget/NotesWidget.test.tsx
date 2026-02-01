import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotesWidget from '../../../../../components/widgets/CenterWidgets/NotesWidget/NotesWidget';

// Mock child components
jest.mock('../../../../../components/widgets/CenterWidgets/NotesWidget/PlainNotes', () => () => (
    <div data-testid="plain-notes-component">PlainNotes Component</div>
));

jest.mock('../../../../../components/widgets/CenterWidgets/NotesWidget/KeyValueNotes', () => () => (
    <div data-testid="key-value-notes-component">KeyValueNotes Component</div>
));

jest.mock('../../../../../components/common/ToggleGroupButton/ToggleGroupButton', () => (props: any) => (
    <div data-testid="toggle-group-button">
        {props.options.map((opt: any) => (
            <button
                key={opt.id}
                data-testid={`toggle-option-${opt.id}`}
                onClick={() => props.onChange([opt.id])}
                aria-pressed={props.selectedValues.includes(opt.id)}
            >
                {opt.label}
            </button>
        ))}
    </div>
));

describe('NotesWidget', () => {
    test('renders toggle with 3 options', () => {
        render(<NotesWidget />);
        expect(screen.getByTestId('toggle-group-button')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-option-PLAIN')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-option-KEY_VALUE')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-option-UPLOAD')).toBeInTheDocument();
    });

    test('defaults to PLAIN mode', () => {
        render(<NotesWidget />);
        const plainOption = screen.getByTestId('toggle-option-PLAIN');
        expect(plainOption).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('plain-notes-component')).toBeInTheDocument();
    });

    test('renders PlainNotes when PLAIN is selected', () => {
        render(<NotesWidget />);
        expect(screen.getByTestId('plain-notes-component')).toBeInTheDocument();
        expect(screen.queryByTestId('key-value-notes-component')).not.toBeInTheDocument();
    });

    test('renders KeyValueNotes when KEY_VALUE is selected', async () => {
        render(<NotesWidget />);
        const keyValueOption = screen.getByTestId('toggle-option-KEY_VALUE');

        await userEvent.click(keyValueOption);

        expect(screen.getByTestId('key-value-notes-component')).toBeInTheDocument();
        expect(screen.queryByTestId('plain-notes-component')).not.toBeInTheDocument();
    });

    test('renders nothing when UPLOAD is selected', async () => {
        render(<NotesWidget />);
        const uploadOption = screen.getByTestId('toggle-option-UPLOAD');

        await userEvent.click(uploadOption);

        expect(screen.queryByTestId('plain-notes-component')).not.toBeInTheDocument();
        expect(screen.queryByTestId('key-value-notes-component')).not.toBeInTheDocument();
    });

    test('switches between modes correctly', async () => {
        render(<NotesWidget />);

        // Start with PLAIN
        expect(screen.getByTestId('plain-notes-component')).toBeInTheDocument();

        // Switch to KEY_VALUE
        await userEvent.click(screen.getByTestId('toggle-option-KEY_VALUE'));
        expect(screen.getByTestId('key-value-notes-component')).toBeInTheDocument();
        expect(screen.queryByTestId('plain-notes-component')).not.toBeInTheDocument();

        // Switch back to PLAIN
        await userEvent.click(screen.getByTestId('toggle-option-PLAIN'));
        expect(screen.getByTestId('plain-notes-component')).toBeInTheDocument();
        expect(screen.queryByTestId('key-value-notes-component')).not.toBeInTheDocument();
    });
});
