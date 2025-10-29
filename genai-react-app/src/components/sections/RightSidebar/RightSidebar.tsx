import React from 'react'
import { useAI } from '../../../context/AIContext'
import AIVendorWidget from '../../widgets/AIVendorWidget/AIVendorWidget'
import styles from './RightSidebar.module.scss'

export default function RightSidebar(): React.ReactElement {
    const { config, setTemperature, setMaxTokens, setTone, resetConfig } = useAI()

    return (
        <div className={styles.sidebar}>
            <h3 className={styles.title}>AI Configuration</h3>

            {/* Vendor selection area */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Vendors</h4>
                <AIVendorWidget />
            </div>

            {/* Generation controls */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Generation Settings</h4>

                <div className={styles.controlGroup}>
                    <label className={styles.label}>Temperature: {config.temperature}</label>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={config.temperature}
                        onChange={e => setTemperature(parseFloat(e.target.value))}
                        className={styles.slider}
                    />
                </div>

                <div className={styles.controlGroup}>
                    <label className={styles.label}>Max Tokens: {config.maxTokens}</label>
                    <input
                        type="number"
                        value={config.maxTokens}
                        min={128}
                        max={8192}
                        step={128}
                        onChange={e => setMaxTokens(parseInt(e.target.value, 10))}
                        className={styles.input}
                    />
                </div>

                <div className={styles.controlGroup}>
                    <label className={styles.label}>Tone</label>
                    <select
                        value={config.tone}
                        onChange={e => setTone(e.target.value)}
                        className={styles.select}
                    >
                        <option value="neutral">Neutral</option>
                        <option value="friendly">Friendly</option>
                        <option value="formal">Formal</option>
                        <option value="creative">Creative</option>
                        <option value="technical">Technical</option>
                    </select>
                </div>
            </div>

            <button onClick={resetConfig} className={styles.resetButton}>
                Reset Settings
            </button>
        </div>
    )
}
