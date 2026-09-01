/**
 * Browser audio plumbing for the voice session:
 *  - MicCapture: microphone -> PCM16 base64 chunks at the session's input rate
 *  - PcmPlayer:  base64 PCM16 deltas at the session's output rate -> speakers
 *
 * The proxy announces the rates in `session.ready` (OpenAI: 24 kHz in,
 * Gemini: 16 kHz in, both 24 kHz out); the browser's hardware rate is
 * whatever it is (typically 44.1/48 kHz), so we resample on the way in and
 * let Web Audio resample on the way out.
 */

/** Streaming linear-interpolation resampler (keeps continuity across chunks). */
class LinearResampler {
  private pos = 0 // fractional read index into the current chunk (may be in [-1, 0))
  private last = 0 // final sample of the previous chunk, for cross-boundary interpolation

  constructor(private inRate: number, private outRate: number) {}

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input
    const step = this.inRate / this.outRate
    const out: number[] = []
    let pos = this.pos
    while (pos < input.length - 1) {
      const i = Math.floor(pos)
      const t = pos - i
      const s0 = i < 0 ? this.last : input[i]
      const s1 = input[i + 1]
      out.push(s0 * (1 - t) + s1 * t)
      pos += step
    }
    this.last = input[input.length - 1]
    this.pos = pos - input.length
    return Float32Array.from(out)
  }
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  const STRIDE = 0x8000
  for (let i = 0; i < bytes.length; i += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STRIDE))
  }
  return btoa(binary)
}

function base64ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000
  return out
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null

  /** Starts the mic and invokes onChunk with base64 PCM16 at targetRate. */
  async start(targetRate: number, onChunk: (b64: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    this.ctx = new AudioContext()
    await this.ctx.audioWorklet.addModule('/pcm-recorder-worklet.js')

    const resampler = new LinearResampler(this.ctx.sampleRate, targetRate)
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const resampled = resampler.process(e.data)
      if (resampled.length > 0) onChunk(int16ToBase64(floatToPcm16(resampled)))
    }
    source.connect(this.node)
    // The worklet only posts messages; nothing is routed to the speakers.
  }

  stop(): void {
    this.node?.port.close()
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close()
    this.node = null
    this.stream = null
    this.ctx = null
  }
}

export class PcmPlayer {
  private ctx: AudioContext
  private cursor = 0 // absolute AudioContext time up to which audio is scheduled
  private sources = new Set<AudioBufferSourceNode>()

  constructor(private sampleRate: number) {
    this.ctx = new AudioContext()
  }

  /** Queues one base64 PCM16 chunk for gapless playback. */
  play(b64: string): void {
    const samples = base64ToFloat32(b64)
    if (samples.length === 0) return
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate)
    buffer.copyToChannel(samples, 0)

    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.ctx.destination)
    const startAt = Math.max(this.cursor, this.ctx.currentTime + 0.05)
    src.start(startAt)
    this.cursor = startAt + buffer.duration
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
  }

  /** Barge-in: drop everything queued and stop immediately. */
  interrupt(): void {
    for (const src of this.sources) {
      try {
        src.stop()
      } catch {
        // already stopped
      }
    }
    this.sources.clear()
    this.cursor = 0
  }

  close(): void {
    this.interrupt()
    this.ctx.close()
  }
}
