import React from 'react';
import Navbar from '../components/Navbar';
import TextField from '../components/TextField';
import styles from './LandingPage.module.scss';

export default function LandingPage(): React.ReactElement {
    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.content}>
                <TextField />
            </div>
        </div>
    );
}