import React, { useState } from 'react'
import styles from './NotesWidget.module.scss'
import ToggleGroupButton, { ToggleOption } from '../../../common/ToggleGroupButton/ToggleGroupButton'
import { ICONS } from '../../../../constants/icons'
import PlainNotes from './PlainNotes'
import KeyValueNotes from './KeyValueNotes'

const NOTE_OPTIONS: ToggleOption[] = [
    { id: 'PLAIN', label: 'Plain Notes', icon: ICONS.EDIT },
    { id: 'KEY_VALUE', label: 'Key Value Notes', icon: ICONS.TOKENS }, // Placeholder for document
    { id: 'UPLOAD', label: 'Upload File', icon: ICONS.PLUS } // Placeholder for upload
]

export default function NotesWidget() {
    const [selectedMode, setSelectedMode] = useState<string[]>(['PLAIN'])

    return (
        <div className={styles.container}>
            <div className={styles.toggleWrapper}>
                <ToggleGroupButton
                    options={NOTE_OPTIONS}
                    selectedValues={selectedMode}
                    onChange={setSelectedMode}
                    allowEmpty={false}
                    singleSelection={true}
                />
            </div>

            {selectedMode[0] === 'PLAIN' && <PlainNotes />}
            {selectedMode[0] === 'KEY_VALUE' && <KeyValueNotes />}
        </div>
    )
}
