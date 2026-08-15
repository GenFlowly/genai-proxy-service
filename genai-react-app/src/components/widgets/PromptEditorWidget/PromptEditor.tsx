import React, { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './PromptEditor.module.scss'

// Lazy load the heavy Markdown editor component
const PromptEditorCore = lazy(() => import('./PromptEditorCore'))

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
    disableCache?: boolean
    height?: string
    className?: string
    'data-testid'?: string
    readOnly?: boolean
    maxLength?: number
    variant?: 'default' | 'seamless'
}

export default function PromptEditor({ id, value, onChange, disableCache = false, height = "50vh", className = '', 'data-testid': testId, readOnly = false, maxLength, variant = 'default' }: PromptEditorProps): React.ReactElement {
    const { t } = useTranslation()

    return (
        <Suspense fallback={
            <div className={`${styles.container} ${variant === 'seamless' ? styles.seamless : ''} ${className}`} data-testid={testId} style={height === '100%' ? { height: '100%' } : {}}>
                <div className={styles.editorWrapper} style={height === '100%' ? { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' } : { display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ color: 'var(--color-text-tertiary)' }}>{t('editor.promptEditor.loadingEditor')}</div>
                </div>
            </div>
        }>
            <PromptEditorCore 
                id={id}
                value={value}
                onChange={onChange}
                disableCache={disableCache}
                height={height}
                className={className}
                data-testid={testId}
                readOnly={readOnly}
                maxLength={maxLength}
                variant={variant}
            />
        </Suspense>
    )
}