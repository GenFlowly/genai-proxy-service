/**
 * Captures mono microphone audio and posts Float32Array chunks (~2048 samples
 * at the AudioContext rate) to the main thread, where they are resampled to
 * the rate requested by the voice session and sent as base64 PCM16.
 */
const CHUNK = 2048

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(CHUNK)
    this.offset = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    let read = 0
    while (read < channel.length) {
      const n = Math.min(channel.length - read, CHUNK - this.offset)
      this.buffer.set(channel.subarray(read, read + n), this.offset)
      this.offset += n
      read += n
      if (this.offset === CHUNK) {
        this.port.postMessage(this.buffer.slice(0))
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-recorder', PcmRecorder)
