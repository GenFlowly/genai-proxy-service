import React from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader, pageHeaderStyles } from '@genflowly/component-library'
import { PillButton } from '@genflowly/component-library'
import { useNotes } from '../../../context/NotesContext'
import { useLayout } from '../../../context/LayoutContext'
import { useResponsiveBreakpoints } from '../../../hooks/useResponsiveBreakpoints'
import MobileHeader from '../MobileHeader/MobileHeader'
import NotesMenuContent from './NotesMenuContent'
import { SaveStatus } from '../../../hooks/useAutosave'
import { parseServerDate } from '../../../utils/timeUtils'
import { ICONS } from '../../../constants/icons'
import i18n from '../../../i18n'

function formatSavedAt(savedAt: Date): string {
    return savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatUpdatedAtLabel(updatedAt: Date): string {
    const now = new Date()
    const sameDay = updatedAt.toDateString() === now.toDateString()
    if (sameDay) return i18n.t('notes.notesHeader.updatedAtTime', { time: formatSavedAt(updatedAt) })

    const date = updatedAt.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(updatedAt.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    })
    return i18n.t('notes.notesHeader.updatedAtDateTime', { date, time: formatSavedAt(updatedAt) })
}

function statusLabel(status: SaveStatus, lastSavedAt: Date | null, noteUpdatedAt: string | null): string | null {
    switch (status) {
        case 'saving':
            return i18n.t('notes.notesHeader.saving')
        case 'error':
            return i18n.t('notes.notesHeader.saveError')
        default:
            if (lastSavedAt) return i18n.t('notes.notesHeader.savedAt', { time: formatSavedAt(lastSavedAt) })
            // No save this session yet: fall back to the note's stored
            // timestamp (server value — parse as UTC)
            if (noteUpdatedAt) {
                const updatedAt = parseServerDate(noteUpdatedAt)
                if (updatedAt) return formatUpdatedAtLabel(updatedAt)
            }
            return null
    }
}

export default function NotesHeader(): React.ReactElement {
    const { t } = useTranslation()
    const { saveStatus, lastSavedAt, noteTitle, activeNote, startNewNote } = useNotes()
    const label = statusLabel(saveStatus, lastSavedAt, activeNote?.updatedAt ?? null)
    const { setLeftSidebarExpanded } = useLayout()
    const { isNarrow } = useResponsiveBreakpoints()

    // No title yet: a fresh editor session is a "New Note"; an opened note
    // whose stored title is missing is an "Untitled Note"
    const title = noteTitle ?? (activeNote ? t('notes.notesHeader.untitledNote') : t('notes.notesHeader.newNote'))

    // Below isNarrow: no navbar/header band — a transparent overlay on the
    // full-screen editor carries the title, save status and page actions
    if (isNarrow) {
        return (
            <MobileHeader
                title={title}
                subtitle={label ?? undefined}
                menuItems={[
                    {
                        label: t('notes.notesHeader.newNote'),
                        onClick: startNewNote,
                        'data-testid': 'new-note-button',
                    },
                ]}
                menuTitle={t('sidebar.savedNotesWidget.title')}
                menuAction={{
                    label: t('notes.notesHeader.newNote'),
                    icon: ICONS.COMPOSE,
                    onClick: () => {
                        startNewNote()
                        setLeftSidebarExpanded(false)
                    },
                    'data-testid': 'menu-new-note-button',
                }}
                menuContent={<NotesMenuContent onClose={() => setLeftSidebarExpanded(false)} />}
            />
        )
    }

    return (
        <PageHeader
            title={title}
            data-testid="notes-header"
            actions={(
                <>
                    {label && (
                        <span
                            className={`${pageHeaderStyles.saveStatus} ${saveStatus === 'error' ? pageHeaderStyles.saveStatusError : ''}`}
                            data-testid="notes-save-status"
                        >
                            {label}
                        </span>
                    )}
                    <PillButton
                        label={t('notes.notesHeader.newNote')}
                        icon={ICONS.PLUS}
                        className={pageHeaderStyles.actionButton}
                        onClick={startNewNote}
                        data-testid="new-note-button"
                    />
                </>
            )}
        />
    )
}
