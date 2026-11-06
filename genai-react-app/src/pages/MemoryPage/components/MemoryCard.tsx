import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { CustomerMemory, MemoryPlacement } from '../../../models/memory.models'
import { formatServerDateOnly } from '../../../utils/timeUtils'
import { kindLabel } from '../memoryLabels'
import styles from '../MemoryPage.module.scss'

export interface MemoryAction {
    id: 'edit' | 'move' | 'copy' | 'delete'
    label: string
    icon: string
    danger?: boolean
    onSelect: () => void
}

export function KebabIcon(): React.ReactElement {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
        </svg>
    )
}

interface MemoryCardProps {
    memory: CustomerMemory
    /** Its placement in the list on screen; project lists show the kind too. */
    placement: MemoryPlacement
    actions: MemoryAction[]
    onOpen: () => void
    /**
     * Set on phones: the kebab hands the actions to the page's bottom sheet
     * instead of opening its own dropdown.
     */
    onShowActions?: () => void
}

/** One memory in a list: tag, text, how often it was used, version and date. */
export default function MemoryCard({ memory, placement, actions, onOpen, onShowActions }: MemoryCardProps): React.ReactElement {
    const { t } = useTranslation()
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!menuOpen) return
        const close = (event: MouseEvent | KeyboardEvent) => {
            if (event instanceof KeyboardEvent) {
                if (event.key === 'Escape') setMenuOpen(false)
                return
            }
            if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', close)
        return () => {
            document.removeEventListener('mousedown', close)
            document.removeEventListener('keydown', close)
        }
    }, [menuOpen])

    const date = formatServerDateOnly(memory.updatedAt || memory.createdAt)

    return (
        <article
            className={`${styles.card} ${menuOpen ? styles.cardMenuOpen : ''}`}
            data-testid={`memory-card-${memory.memoryId}`}
        >
            <div className={styles.cardHead}>
                {memory.category && <span className={styles.tag}>{memory.category}</span>}
                {placement.projectId && (
                    <span className={`${styles.tag} ${styles.tagKind}`}>{kindLabel(placement.kind)}</span>
                )}
                <span className={styles.spacer} />
                <div className={styles.menuAnchor} ref={menuRef}>
                    <button
                        type="button"
                        className={styles.kebab}
                        aria-label={t('memoryPage.list.actions')}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => (onShowActions ? onShowActions() : setMenuOpen(open => !open))}
                        data-testid={`memory-card-actions-${memory.memoryId}`}
                    >
                        <KebabIcon />
                    </button>
                    {menuOpen && (
                        <div className={styles.menu} role="menu" aria-label={t('memoryPage.list.actions')}>
                            {actions.map(action => (
                                <button
                                    key={action.id}
                                    type="button"
                                    role="menuitem"
                                    className={`${styles.menuItem} ${action.danger ? styles.menuItemDanger : ''}`}
                                    onClick={() => {
                                        setMenuOpen(false)
                                        action.onSelect()
                                    }}
                                    data-testid={`memory-action-${action.id}`}
                                >
                                    <Icon src={action.icon} size={15} aria-hidden={true} />
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <button type="button" className={styles.cardText} onClick={onOpen} data-testid={`memory-card-open-${memory.memoryId}`}>
                {memory.text}
            </button>
            <div className={styles.cardFoot}>
                <span>
                    {t('memoryPage.list.used')}{' '}
                    <strong className={styles.count}>{t('memoryPage.list.times', { count: memory.hitCount })}</strong>
                </span>
                <span className={styles.versionBadge}>{t('memoryPage.list.version', { version: memory.version })}</span>
                <span className={styles.spacer} />
                <span>{date}</span>
            </div>
        </article>
    )
}

/** The actions a memory offers in [placement]'s list. Copy is only for project memories. */
export function memoryActions(
    placement: MemoryPlacement,
    handlers: { edit: () => void; move: () => void; copy: () => void; remove: () => void },
    t: (key: string) => string
): MemoryAction[] {
    return [
        { id: 'edit', label: t('memoryPage.list.edit'), icon: ICONS.EDIT, onSelect: handlers.edit },
        { id: 'move', label: t('memoryPage.list.moveTo'), icon: ICONS.ALT_ARROW_RIGHT, onSelect: handlers.move },
        ...(placement.projectId
            ? [{ id: 'copy' as const, label: t('memoryPage.list.copyToProject'), icon: ICONS.COPY, onSelect: handlers.copy }]
            : []),
        { id: 'delete', label: t('memoryPage.list.delete'), icon: ICONS.TRASH, danger: true, onSelect: handlers.remove },
    ]
}
