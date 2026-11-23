import React from 'react'
import { MemoryCard as LibraryMemoryCard } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { CustomerMemory, MemoryPlacement } from '../../../models/memory.models'
import { formatServerDateOnly } from '../../../utils/timeUtils'
import { kindLabel } from '../memoryLabels'

export interface MemoryAction {
    id: 'edit' | 'move' | 'copy' | 'delete'
    label: string
    icon: string
    danger?: boolean
    onSelect: () => void
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

/** One memory in a list: tag, text, how often it was used, version and date (the library card). */
export default function MemoryCard({ memory, placement, actions, onOpen, onShowActions }: MemoryCardProps): React.ReactElement {
    const tags = [
        ...(memory.category ? [{ label: memory.category }] : []),
        ...(placement.projectId ? [{ label: kindLabel(placement.kind), variant: 'kind' as const }] : []),
    ]
    return (
        <LibraryMemoryCard
            text={memory.text}
            tags={tags}
            actions={actions}
            onOpen={onOpen}
            onShowActions={onShowActions}
            showUsage
            usageCount={memory.hitCount}
            version={memory.version}
            date={formatServerDateOnly(memory.updatedAt || memory.createdAt)}
            testId={`memory-card-${memory.memoryId}`}
            actionsTestId={`memory-card-actions-${memory.memoryId}`}
            openTestId={`memory-card-open-${memory.memoryId}`}
        />
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
