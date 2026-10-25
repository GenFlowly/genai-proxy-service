import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { useDefaultsPrefetch } from './useDefaultsPrefetch';
import { useAuth } from '../context/AuthContext';
import { prefetchDefaultsPageData } from '../services/defaultsCacheService';

jest.mock('../context/AuthContext');
jest.mock('../services/defaultsCacheService');

const mockUseAuth = useAuth as jest.Mock;
const mockPrefetch = prefetchDefaultsPageData as jest.Mock;

function Probe(): React.ReactElement {
    useDefaultsPrefetch();
    return <div />;
}

describe('useDefaultsPrefetch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrefetch.mockResolvedValue(undefined);
    });

    test('prefetches once the session is authenticated', async () => {
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            customerId: 'cust-1',
            getAccessTokenSilently: jest.fn().mockResolvedValue('tok'),
        });

        render(<Probe />);

        await waitFor(() => expect(mockPrefetch).toHaveBeenCalledWith('tok', 'cust-1'));
    });

    test('does nothing while unauthenticated', () => {
        mockUseAuth.mockReturnValue({
            isAuthenticated: false,
            customerId: null,
            getAccessTokenSilently: jest.fn(),
        });

        render(<Probe />);

        expect(mockPrefetch).not.toHaveBeenCalled();
    });

    test('a token failure is swallowed', async () => {
        const getToken = jest.fn().mockRejectedValue(new Error('expired'));
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            customerId: 'cust-1',
            getAccessTokenSilently: getToken,
        });

        render(<Probe />);

        await waitFor(() => expect(getToken).toHaveBeenCalled());
        expect(mockPrefetch).not.toHaveBeenCalled();
    });
});
