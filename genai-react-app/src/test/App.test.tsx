import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';

// Mock Onboarding Service (uses __mocks__ manually)
jest.mock('../services/onboardUserService');

test('renders App shell and verifies authenticated state', async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );

  // App redirects / -> /chat -> LandingPage -> Navbar
  // Navbar waits for Auth -> Onboard -> Authenticated
  const avatarImage = await screen.findByTestId('user-avatar-image', {}, { timeout: 5000 });
  expect(avatarImage).toBeInTheDocument();
  expect(avatarImage).toHaveAttribute('alt', 'Neel');
});
