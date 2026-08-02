import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Modal from '../../../../components/common/Modal/Modal';

describe('Modal Component', () => {
    it('renders children when isOpen is true', () => {
        render(
            <Modal isOpen={true} onClose={jest.fn()} title="Test Modal">
                <div>Modal Content</div>
            </Modal>
        );
        expect(screen.getByText('Test Modal')).toBeInTheDocument();
        expect(screen.getByText('Modal Content')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
        render(
            <Modal isOpen={false} onClose={jest.fn()} title="Test Modal">
                <div>Modal Content</div>
            </Modal>
        );
        expect(screen.queryByText('Test Modal')).not.toBeInTheDocument();
    });

    it('calls onClose when close button is clicked', () => {
        const handleClose = jest.fn();
        render(
            <Modal isOpen={true} onClose={handleClose} title="Test Modal">
                <div>Modal Content</div>
            </Modal>
        );
        fireEvent.click(screen.getByText('×'));
        expect(handleClose).toHaveBeenCalledTimes(1);
    });
});
