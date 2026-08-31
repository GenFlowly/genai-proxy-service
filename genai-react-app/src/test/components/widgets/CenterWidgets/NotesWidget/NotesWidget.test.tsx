import React from 'react';
import { render, screen } from '@testing-library/react';
import NotesWidget from '../../../../../components/widgets/CenterWidgets/NotesWidget/NotesWidget';
import '@testing-library/jest-dom';

// Mock child components
jest.mock('../../../../../components/widgets/CenterWidgets/NotesWidget/PlainNotes', () => () => (
    <div data-testid="plain-notes-component">PlainNotes Component</div>
));

describe('NotesWidget', () => {
    test('always renders PlainNotes', () => {
        render(<NotesWidget />);
        expect(screen.getByTestId('plain-notes-component')).toBeInTheDocument();
    });

    test('does not render a mode toggle', () => {
        render(<NotesWidget />);
        expect(screen.queryByTestId('pill-button-group')).not.toBeInTheDocument();
    });
});
