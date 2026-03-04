import React from 'react';
import { render, screen } from '@testing-library/react';
import { CustomerVectorDBConfigStatus } from '../../../../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus';
import { useAuth } from '../../../../context/AuthContext';
import { VectorDBConfigStatusValue } from '../../../../models/storeCustomerVectorDBConfig.models';
import '@testing-library/jest-dom';

// Mock useAuth
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn()
}));

describe('CustomerVectorDBConfigStatus Component', () => {
    const mockUseAuth = useAuth as jest.Mock;
    const defaultProps = {
        vendor: 'Zilliz',
        'data-testid': 'test-status'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders NOT_SET when no status found for vendor', () => {
        mockUseAuth.mockReturnValue({
            vectorDBConfigStatusList: []
        });

        render(<CustomerVectorDBConfigStatus {...defaultProps} />);

        const container = screen.getByTestId('test-status');
        expect(container).toBeInTheDocument();

        const text = screen.getByTestId('test-status-text');
        expect(text).toHaveTextContent(VectorDBConfigStatusValue.NOT_SET);
        expect(screen.queryByTestId('test-status-present')).not.toBeInTheDocument();
    });

    test('renders PRESENT status with icon', () => {
        mockUseAuth.mockReturnValue({
            vectorDBConfigStatusList: [{
                vendor: 'Zilliz',
                status: VectorDBConfigStatusValue.PRESENT,
                isConfigValid: true
            }]
        });

        render(<CustomerVectorDBConfigStatus {...defaultProps} />);

        const presentContainer = screen.getByTestId('test-status-present');
        expect(presentContainer).toBeInTheDocument();

        const icon = screen.getByTestId('test-status-icon');
        expect(icon).toBeInTheDocument();

        expect(screen.getByTestId('test-status-text')).toHaveTextContent(VectorDBConfigStatusValue.PRESENT);
    });

    test('renders NOT_SET status specifically', () => {
        mockUseAuth.mockReturnValue({
            vectorDBConfigStatusList: [{
                vendor: 'Zilliz',
                status: VectorDBConfigStatusValue.NOT_SET,
                isConfigValid: false
            }]
        });

        render(<CustomerVectorDBConfigStatus {...defaultProps} />);

        const otherContainer = screen.getByTestId('test-status-other');
        expect(otherContainer).toBeInTheDocument();

        expect(screen.getByTestId('test-status-text')).toHaveTextContent(VectorDBConfigStatusValue.NOT_SET);
        expect(screen.queryByTestId('test-status-present')).not.toBeInTheDocument();
    });
});
