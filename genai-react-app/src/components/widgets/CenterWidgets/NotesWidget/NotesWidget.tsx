import React from 'react'
import styles from './NotesWidget.module.scss'
import PlainNotes from './PlainNotes'

export default function NotesWidget() {
    return (
        <div className={styles.container}>
            <PlainNotes />
        </div>
    )
}
