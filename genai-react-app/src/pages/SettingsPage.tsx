import React, { useState } from 'react';
import Navbar from '../components/Navbar';
import styles from './SettingsPage.module.scss';

export default function SettingsPage(): React.ReactElement {
    const [aiVendor, setAiVendor] = useState<string>('openai');
    const [apiKey, setApiKey] = useState<string>('');
    const [saved, setSaved] = useState<boolean>(false);

    const handleSubmit = (): void => {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    };

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.content}>
                <div className={styles.card}>
                    <h2 className={styles.title}>Settings</h2>

                    <div className={styles.form}>
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel}>Select AI Vendor</label>
                            <select
                                value={aiVendor}
                                onChange={(e) => setAiVendor(e.target.value)}
                                className={styles.formSelect}
                            >
                                <option value="openai">OpenAI</option>
                                <option value="claude">Claude</option>
                                <option value="gemini">Gemini</option>
                            </select>
                        </div>

                        <div className={styles.formGroup}>
                            <label className={styles.formLabel}>Enter API Key</label>
                            <input
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="sk-..."
                                className={styles.formInput}
                            />
                        </div>

                        <button onClick={handleSubmit} className={styles.submitButton}>
                            Save Settings
                        </button>

                        {saved && (
                            <div className={styles.successMessage}>
                                Settings saved successfully!
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}