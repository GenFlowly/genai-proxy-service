import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@genflowly/component-library'
import { CustomerMemory } from '../../../models/memory.models'
import { MemoryAction } from './MemoryCard'
import styles from '../MemoryPage.module.scss'

interface MemoryActionsSheetProps {
    memory: CustomerMemory
    /** Where it applies and how often it was used, under the text. */
    summary: string
    actions: MemoryAction[]
    onClose: () => void
}

/** Phones: a memory's actions in a sheet from the bottom of the screen. */
export default function MemoryActionsSheet({ memory, summary, actions, onClose }: MemoryActionsSheetProps): React.ReactElement {
    const { t } = useTranslation()

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [onClose])

    return (
        <div className={styles.sheetLayer} data-testid="memory-actions-sheet">
            <button type="button" className={styles.sheetScrim} aria-label={t('memoryPage.list.closeActions')} onClick={onClose} />
            <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={t('memoryPage.list.actions')}>
                <span className={styles.sheetGrip} aria-hidden="true" />
                <div className={styles.sheetSummary}>
                    <p className={styles.sheetText}>{memory.text}</p>
                    <p className={styles.sheetMeta}>{summary}</p>
                </div>
                {actions.map(action => (
                    <button
                        key={action.id}
                        type="button"
                        className={`${styles.sheetAction} ${action.danger ? styles.menuItemDanger : ''}`}
                        onClick={() => {
                            onClose()
                            action.onSelect()
                        }}
                        data-testid={`memory-sheet-${action.id}`}
                    >
                        <Icon src={action.icon} size={20} aria-hidden={true} />
                        {action.label}
                    </button>
                ))}
            </div>
        </div>
    )
}
