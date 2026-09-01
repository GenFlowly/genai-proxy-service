import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GenFlowly Realtime Voice Example',
  description: 'Talk to OpenAI Realtime / Gemini Live through the GenFlowly proxy server',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
