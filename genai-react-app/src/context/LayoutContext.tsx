import React, { createContext, useContext, useState, ReactNode } from 'react'

interface LayoutContextType {
    isLeftVisible: boolean
    isRightVisible: boolean
    toggleLeftSidebar: () => void
    toggleRightSidebar: () => void
    setLeftVisible: (visible: boolean) => void
    setRightVisible: (visible: boolean) => void
}

const LayoutContext = createContext<LayoutContextType | undefined>(undefined)

export const LayoutProvider = ({ children }: { children: ReactNode }) => {
    const [isLeftVisible, setIsLeftVisible] = useState(true)
    const [isRightVisible, setIsRightVisible] = useState(true)

    const toggleLeftSidebar = () => setIsLeftVisible(prev => !prev)
    const toggleRightSidebar = () => setIsRightVisible(prev => !prev)

    const setLeftVisible = (visible: boolean) => setIsLeftVisible(visible)
    const setRightVisible = (visible: boolean) => setIsRightVisible(visible)

    return (
        <LayoutContext.Provider
            value={{
                isLeftVisible,
                isRightVisible,
                toggleLeftSidebar,
                toggleRightSidebar,
                setLeftVisible,
                setRightVisible,
            }}
        >
            {children}
        </LayoutContext.Provider>
    )
}

export const useLayout = (): LayoutContextType => {
    const context = useContext(LayoutContext)
    if (!context) throw new Error('useLayout must be used within a LayoutProvider')
    return context
}
