import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

  // App redirects / -> /chat -> LandingPage -> Navbar
  // Navbar waits for Auth -> Onboard -> Authenticated
  const avatarImage = await screen.findByTestId('user-avatar-button-image', {}, { timeout: 5000 });
  expect(avatarImage).toBeInTheDocument();
  expect(avatarImage).toHaveAttribute('alt', 'Neel');
});
