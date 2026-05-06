/**
 * AI voice inference worker.
 *
 * Loads the on-device neural TTS model in a dedicated Web Worker so heavy
 * inference work doesn't block the popup or service worker. Model weights and
 * voice embeddings are fetched from Hugging Face on first use and stored in
 * the Cache API. No `eval()` or `new Function()` is used anywhere — ONNX
 * Runtime Web runs the model graph via WebAssembly only.
 *
 * Message protocol (postMessage in/out):
 *   In:  { action: 'INIT' }
 *   Out: { event: 'DOWNLOAD_PROGRESS', loaded, total }
 *        { event: 'READY' }
 *        { event: 'ERROR', message }
 *
 *   In:  { action: 'GENERATE', text, voice, speed }
 *   Out: { event: 'AUDIO_READY', audioBuffer (transferable) }
 *        { event: 'ERROR', message }
 *
 *   In:  { action: 'DISPOSE' }
 */

import { KokoroTTS, env } from './kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL_DTYPE = 'q8'; // ~80 MB quantized variant

// Point ONNX Runtime Web at the bundled WASM binaries.
// Without this it would try to fetch them from a CDN.
env.wasmPaths = new URL('../onnx/', import.meta.url).href;

let tts = null;

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  try {
    switch (msg.action) {
      case 'INIT':
        await handleInit();
        break;
      case 'GENERATE':
        await handleGenerate(msg.text, msg.voice, msg.speed);
        break;
      case 'DISPOSE':
        await handleDispose();
        break;
      default:
        // Unknown action — ignore silently
        break;
    }
  } catch (err) {
    self.postMessage({ event: 'ERROR', message: err && err.message ? err.message : String(err) });
  }
});

async function handleInit() {
  if (tts) {
    self.postMessage({ event: 'READY' });
    return;
  }

  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: MODEL_DTYPE,
    device: 'wasm',
    progress_callback: (data) => {
      // transformers.js fires {status, file, loaded, total} as it streams shards.
      // We forward the bytes-loaded values so the UI can show a progress bar.
      if (data && data.status === 'progress' && typeof data.loaded === 'number' && typeof data.total === 'number') {
        self.postMessage({
          event: 'DOWNLOAD_PROGRESS',
          loaded: data.loaded,
          total: data.total,
          file: data.file
        });
      }
    }
  });

  self.postMessage({ event: 'READY' });
}

async function handleGenerate(text, voice, speed) {
  if (!tts) {
    await handleInit();
  }
  if (!text || typeof text !== 'string') {
    throw new Error('No text supplied for generation');
  }

  const audio = await tts.generate(text, {
    voice: voice || 'af_heart',
    speed: typeof speed === 'number' ? speed : 1.0
  });

  // audio.data is Float32Array PCM at audio.sampling_rate (24 kHz).
  // Encode to WAV so the popup can hand it straight to <Audio>.
  const wavBuffer = encodeWav(audio.data, audio.sampling_rate);
  self.postMessage({ event: 'AUDIO_READY', audioBuffer: wavBuffer }, [wavBuffer]);
}

async function handleDispose() {
  if (tts && tts.model && typeof tts.model.dispose === 'function') {
    try { await tts.model.dispose(); } catch (e) { /* ignore */ }
  }
  tts = null;
}

/**
 * Encode mono Float32 PCM into a 16-bit WAV ArrayBuffer.
 * Layout: 44-byte RIFF/WAVE header followed by little-endian int16 samples.
 */
function encodeWav(float32Pcm, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = float32Pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  // "fmt " sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                    // PCM chunk size
  view.setUint16(20, 1, true);                     // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // "data" sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < float32Pcm.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
