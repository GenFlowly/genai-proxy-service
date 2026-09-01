import VoiceChat from '@/components/VoiceChat'

export default function Home() {
  return (
    <main className="page">
      <header className="header">
        <h1>GenFlowly Realtime Voice</h1>
        <p>
          Speech-to-speech via <code>WS /api/v1/voice/session</code> on the GenFlowly proxy server. Pick a model,
          press Start, and talk — transcripts and token usage are persisted to the conversation like text messages.
        </p>
      </header>
      <VoiceChat />
    </main>
  )
}
