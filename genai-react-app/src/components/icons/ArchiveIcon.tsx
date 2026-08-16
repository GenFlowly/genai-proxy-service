import React from 'react';

export default function ArchiveIcon({ className }: { className?: string }): React.ReactElement {
    return (
        <svg
            className={className}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M2 4a1 1 0 011-1h10a1 1 0 011 1v1H2V4z"
                fill="currentColor"
            />
            <path
                d="M3 6h10v7a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm3.5 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z"
                fill="currentColor"
            />
        </svg>
    );
}
