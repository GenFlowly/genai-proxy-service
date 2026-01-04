import React, { useEffect, useState } from 'react'
import styles from './Toast.module.scss'

export interface ToastMessage {
    id: string
    message: string
    duration?: number
}

interface ToastProps {
    toast: ToastMessage
    onRemove: (id: string) => void
}

export const Toast: React.FC<ToastProps> = ({ toast, onRemove }) => {
    const [isExiting, setIsExiting] = useState(false)

    useEffect(() => {
        const duration = toast.duration || 3000

        const timer = setTimeout(() => {
            setIsExiting(true)
        }, duration)

        return () => clearTimeout(timer)
    }, [toast.duration])

    // Wait for exit animation to finish before removing from DOM
    useEffect(() => {
        if (isExiting) {
            const timer = setTimeout(() => {
                onRemove(toast.id)
            }, 300) // Match animation duration
            return () => clearTimeout(timer)
        }
    }, [isExiting, onRemove, toast.id])

    return (
        <div
            className={`${styles.toast} ${isExiting ? styles.exiting : ''}`}
            role="status"
            aria-live="polite"
        >
            {toast.message}
        </div>
    )
}
