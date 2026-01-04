import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { Toast, ToastMessage } from '../components/common/Toast/Toast'
import styles from '../components/common/Toast/Toast.module.scss'

interface ToastContextType {
    showToast: (message: string, duration?: number) => void
}

const ToastContext = createContext<ToastContextType | null>(null)

export const ToastProvider = ({ children }: { children: ReactNode }) => {
    const [toasts, setToasts] = useState<ToastMessage[]>([])

    const showToast = useCallback((message: string, duration?: number) => {
        const id = Date.now().toString() + Math.random().toString(36).substring(2)
        setToasts((prev) => [...prev, { id, message, duration }])
    }, [])

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
    }, [])

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className={styles.toastContainer}>
                {toasts.map((toast) => (
                    <Toast
                        key={toast.id}
                        toast={toast}
                        onRemove={removeToast}
                    />
                ))}
            </div>
        </ToastContext.Provider>
    )
}

export const useToast = (): ToastContextType => {
    const context = useContext(ToastContext)
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider')
    }
    return context
}
