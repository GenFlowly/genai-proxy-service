import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import LandingPage from './pages/LandingPage'
import SettingsPage from './pages/SettingsPage'

export default function AppContent(): React.ReactElement {
    const { isLoading } = useAuth()

    if (isLoading) return <div>Loading...</div>

    return (
        <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
        </Routes>
    )
}
