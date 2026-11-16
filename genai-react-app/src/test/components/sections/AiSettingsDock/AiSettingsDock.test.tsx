import React from 'react'
import { act, render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import AiSettingsDock from '../../../../components/sections/AiSettingsDock/AiSettingsDock'
import { LayoutProvider, useLayout, AI_DOCK_STORAGE_KEY } from '../../../../context/LayoutContext'

jest.mock('../../../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget', () => () => <section data-testid="models-card" />)
jest.mock('../../../../components/widgets/SidebarWidgets/AgentPickerWidget/AgentPickerWidget', () => () => <section data-testid="agent-card" />)
jest.mock('../../../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter', () => () => <section data-testid="tokens-card" />)

let openModal: () => void = () => {}
const ModalOpener = () => {
    const { setRightSidebarExpanded } = useLayout()
    openModal = () => setRightSidebarExpanded(true)
    return null
}

const renderDock = () => render(
    <LayoutProvider>
        <ModalOpener />
        <AiSettingsDock />
    </LayoutProvider>
)

const setWidth = (width: number) => {
    act(() => {
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width })
        window.dispatchEvent(new Event('resize'))
    })
}

describe('AiSettingsDock', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => setWidth(1280))

    test('desktop: the three cards and a strip at the foot that collapses the dock', () => {
        renderDock()
        const dock = screen.getByRole('complementary', { name: 'AI settings' })
        expect(dock).toContainElement(screen.getByTestId('models-card'))
        expect(dock).toContainElement(screen.getByTestId('agent-card'))
        expect(dock).toContainElement(screen.getByTestId('tokens-card'))
        // Nothing sits ahead of the first card in the gap: the scroll area's own
        // first child is its scrollbar track, so the cards have a wrapper
        expect(screen.getByTestId('ai-dock-cards').firstElementChild).toBe(screen.getByTestId('models-card'))

        fireEvent.click(screen.getByRole('button', { name: 'Collapse Sidebar' }))
        expect(screen.getByTestId('ai-dock-strip')).toBeInTheDocument()
        expect(screen.queryByTestId('models-card')).not.toBeInTheDocument()
        expect(localStorage.getItem(AI_DOCK_STORAGE_KEY)).toBe('collapsed')
    })

    test('desktop strip: each card icon and the chevron expand the dock', () => {
        localStorage.setItem(AI_DOCK_STORAGE_KEY, 'collapsed')
        renderDock()

        for (const name of ['Models', 'Agent', 'Tokens']) {
            fireEvent.click(screen.getByRole('button', { name }))
            expect(screen.getByTestId('models-card')).toBeInTheDocument()
            fireEvent.click(screen.getByRole('button', { name: 'Collapse Sidebar' }))
        }

        fireEvent.click(screen.getByRole('button', { name: 'Expand Sidebar' }))
        expect(screen.getByTestId('models-card')).toBeInTheDocument()
    })

    test('phone: nothing until AI Settings opens the modal; Close Settings closes it', () => {
        setWidth(600)
        renderDock()
        expect(screen.queryByTestId('ai-settings-modal')).not.toBeInTheDocument()
        expect(screen.queryByTestId('models-card')).not.toBeInTheDocument()

        act(() => openModal())
        expect(screen.getByTestId('ai-settings-modal')).toContainElement(screen.getByTestId('tokens-card'))

        fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
        expect(screen.queryByTestId('ai-settings-modal')).not.toBeInTheDocument()
    })
})
