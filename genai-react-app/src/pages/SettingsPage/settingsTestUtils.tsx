import React from 'react'
import { render, RenderResult } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { SettingsShellContext, SettingsShellValue } from './SettingsShellContext'

/** Renders one settings page the way the shell does: in a router, with the shell context. */
export function renderSettingsPage(
    ui: React.ReactElement,
    { narrow = false, path = '/settings', shell = {} }: { narrow?: boolean; path?: string; shell?: Partial<SettingsShellValue> } = {}
): RenderResult {
    const value: SettingsShellValue = {
        narrow,
        infoOpen: false,
        openInfo: jest.fn(),
        closeInfo: jest.fn(),
        setHeader: jest.fn(),
        ...shell,
    }
    return render(
        <MemoryRouter initialEntries={[path]}>
            <SettingsShellContext.Provider value={value}>{ui}</SettingsShellContext.Provider>
        </MemoryRouter>
    )
}
