import React, { ReactElement } from 'react'
import { render, RenderOptions } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../context/ThemeContext'
import { AuthProvider } from '../context/AuthContext'
import { LayoutProvider } from '../context/LayoutContext'
import { ToastProvider } from '../context/ToastContext'
import { AIProvider } from '../context/AIContext'
import { ConversationProvider } from '../context/ConversationContext'

// A Component that wraps children with all the Providers used in the app
// The order matches AppContent / App hierarchy roughly
const AllTheProviders = ({ children }: { children: React.ReactNode }) => {
    return (
        <MemoryRouter>
            <LayoutProvider>
                <ToastProvider>
                    <ThemeProvider>
                        <AuthProvider>
                            <AIProvider>
                                <ConversationProvider>
                                    {children}
                                </ConversationProvider>
                            </AIProvider>
                        </AuthProvider>
                    </ThemeProvider>
                </ToastProvider>
            </LayoutProvider>
        </MemoryRouter>
    )
}

const customRender = (
    ui: ReactElement,
    options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllTheProviders, ...options })

// Re-export everything
export * from '@testing-library/react'

// Override render method
export { customRender as render }
