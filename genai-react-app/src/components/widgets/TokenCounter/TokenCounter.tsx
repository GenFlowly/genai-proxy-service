// src/components/common/TokenCounter.tsx
import React from 'react'
import { useAI } from '../../../context/AIContext'

export default function TokenCounter() {
    const { tokenCount, isTokenLoading } = useAI()

    return (
        <div className="text-xs text-gray-500 mt-1">
            {isTokenLoading ? 'Counting tokens…' : `Tokens: ${tokenCount}`}
        </div>
    )
}
