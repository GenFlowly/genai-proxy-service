import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { useNotes } from '../../../context/NotesContext'
import { useToast } from '../../../context/ToastContext'
import { getNotes } from '../../../services/saveNotesService'
import { SearchResultItem } from '../../../services/searchService'
import MobileMenuBody from '../MobileMenuBody/MobileMenuBody'
import MenuSearchResults from '../MobileMenuBody/MenuSearchResults'
import SavedNotesWidget from '../SidebarWidgets/SavedNotesWidget/SavedNotesWidget'
import { loadNotesCache } from '../SidebarWidgets/SavedNotesWidget/notesCache'

const SEARCH_TYPES = ['notes' as const]

/** The Memory page's L2 Menu: saved notes, or search results. */
export default function NotesMenuContent({ onClose }: { onClose: () => void }): React.ReactElement {
    const { t } = useTranslation()
    const { getAccessTokenSilently, customerId } = useAuth()
    const { openNote } = useNotes()
    const { showToast } = useToast()
    const [query, setQuery] = useState('')

    const openResult = async (result: SearchResultItem) => {
        try {
            const cached = loadNotesCache(customerId)?.find(n => n.noteKey === result.key)
            const note = cached ?? (await getNotes(await getAccessTokenSilently())).find(n => n.noteKey === result.key)
            if (!note) throw new Error(`Note ${result.key} not found`)
            openNote(note)
            onClose()
        } catch (error) {
            console.error('Failed to open search result:', error)
            showToast(t('sidebar.savedNotesWidget.couldNotLoadNotes'))
        }
    }

    return (
        <MobileMenuBody
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder={t('layout.mobileMenu.searchNotes')}
            results={query.trim() !== '' ? (
                <MenuSearchResults
                    query={query}
                    types={SEARCH_TYPES}
                    untitledLabel={t('sidebar.savedNotesWidget.untitled')}
                    onSelect={openResult}
                />
            ) : undefined}
        >
            <SavedNotesWidget menu onSelect={onClose} />
        </MobileMenuBody>
    )
}
