import React from 'react';
import { render, screen } from '@testing-library/react';
import { CustomerVectorDBConfigStatus } from '../../../../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus';
import { useAuth } from '../../../../context/AuthContext';
import { VectorDBConfigStatusValue } from '../../../../models/storeCustomerVectorDBConfig.models';
import '@testing-library/jest-dom';

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}));

describe('CustomerVectorDBConfigStatus', () => {
    const mockUseAuth = useAuth as jest.Mock;
    const props = { vendor: 'Zilliz', 'data-testid': 'test-status' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('says "Not connected" when the vendor has no status', () => {
        mockUseAuth.mockReturnValue({ vectorDBConfigStatusList: [] });

        render(<CustomerVectorDBConfigStatus {...props} />);

        expect(screen.getByTestId('test-status')).toHaveTextContent('Not connected');
        expect(screen.getByTestId('test-status-other')).toBeInTheDocument();
        expect(screen.queryByTestId('test-status-present')).not.toBeInTheDocument();
    });

    test('says "Connected" for a saved connection, matching the vendor in any case', () => {
        mockUseAuth.mockReturnValue({
            vectorDBConfigStatusList: [{ vendor: 'zilliz', status: VectorDBConfigStatusValue.PRESENT, isConfigValid: true }],
        });

        render(<CustomerVectorDBConfigStatus {...props} />);

        expect(screen.getByTestId('test-status-present')).toHaveTextContent('Connected');
    });

    test('says "Not connected" for a NOT_SET status', () => {
        mockUseAuth.mockReturnValue({
            vectorDBConfigStatusList: [{ vendor: 'Zilliz', status: VectorDBConfigStatusValue.NOT_SET, isConfigValid: false }],
        });

        render(<CustomerVectorDBConfigStatus {...props} />);

        expect(screen.getByTestId('test-status-other')).toHaveTextContent('Not connected');
    });
});
