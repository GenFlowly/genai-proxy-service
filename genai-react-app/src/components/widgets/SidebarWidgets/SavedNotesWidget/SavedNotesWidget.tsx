import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../../../i18n'
import { useAuth } from '../../../../context/AuthContext'
import { useNotes } from '../../../../context/NotesContext'
import { getNotes, deleteNote, SavedNote } from '../../../../services/saveNotesService'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../../constants/icons'
import { DeleteConfirmModal } from '../../../common/DeleteConfirmModal/DeleteConfirmModal'
import { SidebarCard, SidebarListPanel, SidebarListGroup } from '@genflowly/component-library'
import { sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import { formatServerDateTime, formatServerTime } from '../../../../utils/timeUtils'
import { groupByDate, DateGroupId } from '../../../../utils/dateGrouping'
import { getExpandedSection, setExpandedSection } from '../../ConversationHistoryWidget/historyCache'
import { loadNotesCache, saveNotesCache } from './notesCache'

const noteLabel = (note: SavedNote): string => {
    if (note.title && note.title !== 'Untitled') return note.title
    const firstLine = note.noteValue.split('\n').find(line => line.trim().length > 0)
    return firstLine?.trim() || i18n.t('sidebar.savedNotesWidget.untitled')
}

interface SavedNotesWidgetProps {
    /** Called after a note is opened (e.g. to close the mobile menu). */
    onSelect?: () => void
    // The full-screen mobile menu: a single card under a collapsible header
    menu?: boolean
    'data-testid'?: string
}

export default function SavedNotesWidget({ onSelect, menu = false, 'data-testid': testId }: SavedNotesWidgetProps = {}) {
    const { t } = useTranslation()
    const { getAccessTokenSilently, customerId } = useAuth()
    const { openNote, activeNote, updatedNote, clearActiveNote } = useNotes()

    // Stale-while-revalidate: paint the last known list immediately (if any),
    // then refresh from the API in the background
    const cached = useMemo(() => loadNotesCache(customerId), [customerId])
    const [notes, setNotes] = useState<SavedNote[]>(cached ?? [])
    const [isLoading, setIsLoading] = useState(true)
    const [hasError, setHasError] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState<SavedNote | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)

    // Only persist state to the cache once a real load has happened, so an
    // empty "never loaded" state can't masquerade as "no notes"
    const hasLoadedRef = React.useRef(!!cached)

    useEffect(() => {
        let cancelled = false

        const fetchNotes = async () => {
            try {
                const token = await getAccessTokenSilently()
                const fetchedNotes = await getNotes(token)
                if (!cancelled) {
                    hasLoadedRef.current = true
                    setNotes(fetchedNotes)
                }
            } catch (error) {
                console.error('Failed to fetch saved notes:', error)
                if (!cancelled) setHasError(true)
            } finally {
                if (!cancelled) setIsLoading(false)
            }
        }

        fetchNotes()
        return () => { cancelled = true }
    }, [getAccessTokenSilently])

    // Mirror every loaded/mutated state (fetch, delete, autosave merge) to
    // the cache so the next mount paints instantly
    useEffect(() => {
        if (!hasLoadedRef.current) return
        saveNotesCache(customerId, notes)
    }, [customerId, notes])

    // Keep the list in sync with autosaves published by the editor: update
    // saved notes in place, and surface brand-new notes at the top
    useEffect(() => {
        if (!updatedNote) return
        setNotes(prev => {
            const index = prev.findIndex(n => n.noteKey === updatedNote.noteKey)
            if (index === -1) return [updatedNote, ...prev]
            const next = [...prev]
            next[index] = updatedNote
            return next
        })
    }, [updatedNote])

    // Deleting is permanent, so it always asks first
    const handleDelete = async () => {
        if (!deleteTarget) return
        const noteKey = deleteTarget.noteKey
        setIsDeleting(true)
        setDeleteError(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteNote(token, noteKey)
            setNotes(prev => prev.filter(n => n.noteKey !== noteKey))
            setDeleteTarget(null)
            if (noteKey === activeNote?.noteKey) {
                clearActiveNote()
            }
        } catch (err) {
            console.error('Failed to delete note:', err)
            setDeleteError(t('sidebar.savedNotesWidget.deleteFailed'))
        } finally {
            setIsDeleting(false)
        }
    }

    const groupedNotes = useMemo(
        () => groupByDate(notes, note => note.updatedAt || note.createdAt),
        [notes]
    )

    const groupLabels: Record<DateGroupId, string> = {
        today: t('common.dateGroups.today'),
        yesterday: t('common.dateGroups.yesterday'),
        last7Days: t('common.dateGroups.last7Days'),
        older: t('common.dateGroups.older'),
    }

    const groups: SidebarListGroup[] = groupedNotes.map(group => ({
        id: group.id,
        label: groupLabels[group.id],
        items: group.items.map(note => {
            const savedAt = note.updatedAt || note.createdAt
            const timestamp = group.id === 'today' || group.id === 'yesterday'
                // The group header already names the day — time only
                ? formatServerTime(savedAt)
                : formatServerDateTime(savedAt)
            return {
                id: note.noteKey,
                label: noteLabel(note),
                details: timestamp
                    ? <span className={panelStyles.timestamp}>{timestamp}</span>
                    : undefined,
                isActive: activeNote?.noteKey === note.noteKey,
                onSelect: () => {
                    openNote(note)
                    onSelect?.()
                },
                testId: `saved-note-${note.noteKey}`,
                action: {
                    icon: <Icon src={ICONS.TRASH} size={14} aria-hidden={true} />,
                    label: t('sidebar.savedNotesWidget.deleteNote'),
                    tone: 'muted' as const,
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        setDeleteError(null)
                        setDeleteTarget(note)
                    },
                    testId: `note-delete-btn-${note.noteKey}`,
                },
            }
        }),
    }))

    const panel = (
        <SidebarListPanel
            title={menu ? undefined : t('sidebar.savedNotesWidget.title')}
            variant={menu ? 'menu' : 'default'}
            groups={menu && groups.length > 0
                ? [{
                    id: 'saved-notes',
                    label: t('sidebar.savedNotesWidget.title'),
                    collapsible: true,
                    defaultExpanded: getExpandedSection('savedNotes') ?? true,
                    onToggle: expanded => setExpandedSection('savedNotes', expanded),
                    testId: 'saved-notes-heading',
                    groups,
                }]
                : groups}
            isLoading={isLoading}
            hasError={hasError}
            errorText={t('sidebar.savedNotesWidget.couldNotLoadNotes')}
            emptyText={t('sidebar.savedNotesWidget.noSavedNotesYet')}
            listAriaLabel={t('sidebar.savedNotesWidget.title')}
            data-testid={testId || 'saved-notes-widget'}
            testIds={{
                list: 'saved-notes-list',
                loading: 'saved-notes-loading',
                error: 'saved-notes-error',
                empty: 'saved-notes-empty',
            }}
        />
    )

    const dialog = (
        <DeleteConfirmModal
            isOpen={deleteTarget != null}
            title={t('sidebar.savedNotesWidget.deleteNoteTitle')}
            message={t('sidebar.savedNotesWidget.deleteNoteConfirm')}
            isDeleting={isDeleting}
            error={deleteError}
            onConfirm={handleDelete}
            onCancel={() => setDeleteTarget(null)}
            data-testid="delete-note"
        />
    )

    return (
        <>
            {menu ? <SidebarCard>{panel}</SidebarCard> : panel}
            {dialog}
        </>
    )
}
