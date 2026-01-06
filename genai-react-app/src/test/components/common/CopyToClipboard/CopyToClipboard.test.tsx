import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import CopyToClipboard from '../../../../components/common/CopyToClipboard/CopyToClipboard';
import { ICONS } from '../../../../constants/icons';
import '@testing-library/jest-dom';

// Mock navigator.clipboard
const mockWriteText = jest.fn();
Object.assign(navigator, {
    clipboard: {
        writeText: mockWriteText,
    },
});

describe('CopyToClipboard Component', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('renders with default label', () => {
        render(<CopyToClipboard content="test content" />);
        const button = screen.getByTestId('copy-to-clipboard-button');
        expect(button).toBeInTheDocument();
        expect(button).toHaveTextContent('Copy');
    });

    test('renders with custom label', () => {
        render(<CopyToClipboard content="test content" label="Copy Link" />);
        const button = screen.getByTestId('copy-to-clipboard-button');
        expect(button).toHaveTextContent('Copy Link');
    });

    test('copies content to clipboard on click', async () => {
        render(<CopyToClipboard content="secret text" />);
        const button = screen.getByTestId('copy-to-clipboard-button');

        await act(async () => {
            fireEvent.click(button);
        });

        expect(mockWriteText).toHaveBeenCalledWith('secret text');
    });

    test('shows success message after copying', async () => {
        render(<CopyToClipboard content="test" successMessage="Done!" />);
        const button = screen.getByTestId('copy-to-clipboard-button');

        await act(async () => {
            fireEvent.click(button);
        });

        expect(button).toHaveTextContent('Done!');
    });

    test('reverts to label after duration', async () => {
        render(<CopyToClipboard content="test" successDuration={1000} label="Original" />);
        const button = screen.getByTestId('copy-to-clipboard-button');

        await act(async () => {
            fireEvent.click(button);
        });

        expect(button).toHaveTextContent('✓ Copied'); // Default success message

        // Fast-forward time
        act(() => {
            jest.advanceTimersByTime(1000);
        });

        expect(button).toHaveTextContent('Original');
    });

    test('is disabled when content is empty', () => {
        render(<CopyToClipboard content="" label="Copy" />);
        const button = screen.getByTestId('copy-to-clipboard-button');
        expect(button).toBeDisabled();
    });

    test('is disabled when disabled prop is true', () => {
        render(<CopyToClipboard content="text" disabled={true} />);
        const button = screen.getByTestId('copy-to-clipboard-button');
        expect(button).toBeDisabled();
    });
});
