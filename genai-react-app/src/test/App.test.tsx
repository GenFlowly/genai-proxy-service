import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import App from '../App';

import { mockOnboardResponse } from './fixtures/customerProfile';
import { onboardCustomer } from '../services/onboardUserService';

jest.mock('../services/onboardUserService', () => ({
  onboardCustomer: jest.fn()
}));

test('renders App shell and verifies authenticated state', async () => {
  (onboardCustomer as jest.Mock).mockResolvedValue(mockOnboardResponse);

  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );

  // Verify AuthContext triggers onboarding
  await waitFor(() => {
    expect(onboardCustomer).toHaveBeenCalled();
  });

  // App redirects / -> /chat -> LandingPage -> Navbar
  // Navbar waits for Auth -> Onboard -> Authenticated
  const avatarImage = await screen.findByTestId('user-avatar-button-image', {}, { timeout: 10000 });
  expect(avatarImage).toBeInTheDocument();
  expect(avatarImage).toHaveAttribute('alt', 'Test User');
});
