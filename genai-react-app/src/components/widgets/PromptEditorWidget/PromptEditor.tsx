import React, { Suspense, lazy } from 'react'
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
}

export default function PromptEditor({ id, value, onChange, disableCache = false, height = "40.25rem", className = '', 'data-testid': testId, readOnly = false }: PromptEditorProps): React.ReactElement {

    return (
        <Suspense fallback={
            <div className={`${styles.container} ${className}`} data-testid={testId} style={height === '100%' ? { height: '100%' } : {}}>
                <div className={styles.editorWrapper} style={height === '100%' ? { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' } : { display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ color: 'var(--color-text-tertiary)' }}>Loading editor...</div>
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
            />
        </Suspense>
    )
}