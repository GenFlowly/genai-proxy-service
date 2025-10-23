import React, { useState } from 'react';
import styles from './TextField.module.scss';

export default function TextField(): React.ReactElement {
    const [text, setText] = useState<string>('');

    return (
        <div className={styles.container}>
            <label className={styles.label}>Enter your text</label>
            <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type something..."
                className={styles.input}
            />
            {text && (
                <p className={styles.output}>
                    You typed: <span className={styles.outputText}>{text}</span>
                </p>
            )}
        </div>
    );
}