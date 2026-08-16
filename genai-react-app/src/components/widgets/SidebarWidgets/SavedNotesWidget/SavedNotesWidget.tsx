import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../../../i18n'
import { useAuth } from '../../../../context/AuthContext'
import { useNotes } from '../../../../context/NotesContext'
import { getNotes, deleteNote, SavedNote } from '../../../../services/saveNotesService'
import ArchiveIcon from '../../../icons/ArchiveIcon'
import SidebarListPanel, { SidebarListGroup } from '../../../common/SidebarListPanel/SidebarListPanel'
import panelStyles from '../../../common/SidebarListPanel/SidebarListPanel.module.scss'
import { formatServerDateTime, formatServerTime } from '../../../../utils/timeUtils'
import { groupByDate, DateGroupId } from '../../../../utils/dateGrouping'
import { loadNotesCache, saveNotesCache } from './notesCache'

const noteLabel = (note: SavedNote): string => {
    if (note.title && note.title !== 'Untitled') return note.title
    const firstLine = note.noteValue.split('\n').find(line => line.trim().length > 0)
    return firstLine?.trim() || i18n.t('sidebar.savedNotesWidget.untitled')
}

export default function SavedNotesWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { t } = useTranslation()
    const { getAccessTokenSilently } = useAuth()
    const { openNote, activeNote, updatedNote, clearActiveNote } = useNotes()

    // Stale-while-revalidate: paint the last known list immediately (if any),
    // then refresh from the API in the background
    const cached = useMemo(loadNotesCache, [])
    const [notes, setNotes] = useState<SavedNote[]>(cached ?? [])
    const [isLoading, setIsLoading] = useState(true)
    const [hasError, setHasError] = useState(false)

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

    // Mirror every loaded/mutated state (fetch, archive, autosave merge) to
    // the cache so the next mount paints instantly
    useEffect(() => {
        if (!hasLoadedRef.current) return
        saveNotesCache(notes)
    }, [notes])

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

    const handleArchive = async (e: React.MouseEvent, noteKey: string) => {
        e.stopPropagation()
        try {
            const token = await getAccessTokenSilently()
            await deleteNote(token, noteKey)
            setNotes(prev => prev.filter(n => n.noteKey !== noteKey))
            // If the archived note is currently open in the editor, close it
            if (noteKey === activeNote?.noteKey) {
                clearActiveNote()
            }
        } catch (err) {
            console.error('Failed to archive note:', err)
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
                onSelect: () => openNote(note),
                testId: `saved-note-${note.noteKey}`,
                action: {
                    icon: <ArchiveIcon />,
                    label: t('sidebar.savedNotesWidget.archiveNote'),
                    onClick: (e: React.MouseEvent) => handleArchive(e, note.noteKey),
                    testId: `note-archive-btn-${note.noteKey}`,
                },
            }
        }),
    }))

    return (
        <SidebarListPanel
            title={t('sidebar.savedNotesWidget.title')}
            groups={groups}
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
}
