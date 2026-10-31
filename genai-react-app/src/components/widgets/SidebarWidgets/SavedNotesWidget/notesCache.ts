import { SavedNote } from '../../../../services/saveNotesService'
import { createCustomerCache } from '../../../../utils/customerListCache'
import { StorageSuffix } from '../../../../utils/storageKeys'

const store = createCustomerCache<SavedNote[]>(StorageSuffix.savedNotes, parsed =>
    Array.isArray(parsed) ? (parsed as SavedNote[]) : null
)

export function loadNotesCache(customerId: string | null): SavedNote[] | null {
    return store.load(customerId)
}

export function saveNotesCache(customerId: string | null, notes: SavedNote[]): void {
    store.save(customerId, notes)
}

/** Logout hook / test helper: forget everything, for every customer. */
export function clearNotesCache(): void {
    store.clear()
}
