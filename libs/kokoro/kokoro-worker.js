/**
 * AI voice inference worker.
 *
 * Loads the on-device neural TTS model in a dedicated Web Worker so heavy
 * inference work doesn't block the popup or service worker. Model weights and
 * voice embeddings are bundled with the extension. No `eval()` or
 * `new Function()` is used anywhere - ONNX Runtime Web runs the model graph
 * via WebAssembly only.
 *
 * Message protocol (postMessage in/out):
 *   In:  { action: 'INIT', voice? }
 *        // voice is the user's saved AI voice (e.g. "af_heart"). When supplied,
 *        // the worker runs a 1-token warmup generate with that voice so ORT's
 *        // first-execute JIT and the voice embedding load are paid before any
 *        // user click arrives.
 *   Out: { event: 'READY' }
 *        { event: 'ERROR', message }
 *
 *   In:  { action: 'GENERATE', text, voice, speed, streamId }
 *        // Streams audio sentence-by-sentence so the manager can start playback
 *        // after the first chunk instead of waiting for the whole paragraph.
 *   Out: { event: 'AUDIO_CHUNK', audioBuffer (transferable), streamId,
 *                 sentenceText, sentenceIndex }
 *        { event: 'AUDIO_DONE', streamId }
 *        { event: 'ERROR', message }
 *
 *   In:  { action: 'ABORT' }
 *        // Cancels any in-flight stream loop on its next iteration.
 */

import { KokoroTTS, TextSplitterStream, env } from './kokoro.web.js';

// Load the bundled Kokoro model from the extension's own origin instead of
// fetching at runtime from huggingface.co. This avoids CORS-on-redirect issues
// with HF's Xet CDN and removes the need for the user to wait for a download.
// The q8-quantized variant ships in libs/kokoro-model/ (see scripts/fetch-kokoro-model.sh).
//
// Note: `chrome.*` APIs are not available inside dedicated Web Workers, even
// when spawned from extension contexts — only the extension service worker
// and extension pages get `chrome.runtime.getURL`. Resolve relative to the
// worker's own module URL instead. This produces the same chrome-extension://
// URL the runtime API would have returned.
//
// MODEL_ID has to satisfy transformers.js's HF-repo-id regex
// (/^(\b[\w\-.]+\b\/)?\b[\w\-.]{1,96}\b$/) — otherwise it gets classified as
// a non-repo path and `localModelPath` is silently NOT prepended, so fetches
// go to "./config.json" relative to the worker URL and 404. A bare "." fails
// that regex (the surrounding \b can't match a non-word char), which is why
// the AI path was failing with "Local file missing at './config.json'".
// Use the directory name as the model id and point localModelPath one level
// up so the resolved URL lands on libs/kokoro-model/<file>.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL('../', import.meta.url).href;

// transformers.js wraps every model fetch with `caches.put()`, but the Cache
// API rejects chrome-extension:// requests with a TypeError. The model still
// loads (it's bundled — the extension package itself is the cache), but the
// failed put() spams the console with "Request scheme 'chrome-extension' is
// unsupported". Disable the redundant cache layer entirely.
env.useBrowserCache = false;

// kokoro-js's voice loader hardcodes a Hugging Face URL — it does NOT honor
// env.localModelPath like the model loader does. Bundled voice files exist at
// libs/kokoro-model/voices/*.bin; intercept fetches to that HF prefix and
// serve the bundled file instead. Without this, on a flaky network or a
// CORS-on-redirect hit the loader would fall through to HF and a corrupt
// response would feed garbage to the model (audio that sounds like
// nonsense in another language).
const HF_VOICE_PREFIX = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/';
const _origFetch = self.fetch.bind(self);
self.fetch = function(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith(HF_VOICE_PREFIX)) {
    const file = url.slice(HF_VOICE_PREFIX.length);
    const localUrl = new URL('../kokoro-model/voices/' + file, import.meta.url).href;
    return _origFetch(localUrl, init);
  }
  return _origFetch(input, init);
};

const MODEL_ID = 'kokoro-model';
const MODEL_DTYPE = 'q8'; // 8-bit quantized variant (~92 MB), bundled.
// (We tested q4 first — Kokoro's q4 keeps outlier weights at higher precision,
//  so it's ~290 MB, larger than q8. q8 is both smaller AND slightly higher
//  quality, plus fits under GitHub's 100 MB per-file limit without Git LFS.)

// Point ONNX Runtime Web at the bundled WASM binaries.
// Without this it would try to fetch them from a CDN.
env.wasmPaths = new URL('../onnx/', import.meta.url).href;

// Multi-threaded WASM. The bundled `ort-wasm-simd-threaded.jsep` build spins
// up em-pthread workers when SharedArrayBuffer is available, which the
// manifest's COI keys (cross_origin_embedder_policy / cross_origin_opener_policy)
// guarantee inside this extension. Single-threaded was the previous default
// and was the root cause of "Generation timed out": kokoro-js's published
// numbers show WASM is ~10x slower than WebGPU and single-threaded is
// another ~2-4x slower than threaded, so 30-90 s timeouts were routine.
//
// Cap threads at 4 — and DON'T raise it. ORT-web's own internal default is
// `min(hc/2, 4)`. For small transformer models (Kokoro is 82M params),
// going above 4 routinely *regresses* due to WASM thread-sync overhead and
// E-core contention on hybrid CPUs. Confirmed in onnxruntime/issues #23384
// and adrianlyjak's Kokoro-on-ONNX writeup.
//
// proxy:false avoids spawning the ort-wasm-proxy-worker — we already run
// inside a dedicated module worker (kokoro-worker.js), so the extra hop is
// pure overhead.
if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, hc));
  env.backends.onnx.wasm.proxy = false;
}

// We deliberately do NOT use WebGPU. Kokoro on WebGPU via the JSEP backend
// has many ops that fall back to CPU (per ORT's
// VerifyEachNodeIsAssignedToAnEp warning) — the resulting GPU↔CPU shuffles
// frequently make it slower than multi-threaded WASM, and on Windows with
// q8 quantization the CPU/GPU bridging has produced incorrect tensor
// outputs (audio that sounds like nonsense or a different language).
// Multi-threaded WASM produces correct audio reliably across machines.

let tts = null;
// Cached in-flight init promise. INIT is idempotent for a *single* caller,
// but the manager's _init and a follow-up GENERATE that arrives before the
// first INIT resolves can both call handleInit. Without a cached promise,
// each call would reach `tts === null` and re-enter `from_pretrained`,
// double-loading the 92 MB model. Resetting to null on failure means a
// transient error doesn't poison every later call.
let initPromise = null;

// Bumped on every GENERATE and on every ABORT. The streaming for-await loop
// captures its own id at start and bails on the next iteration if the global
// id has moved past it. ABORT and a re-issued GENERATE both look identical
// to a running loop ("the world has moved on"), which is what we want.
let activeStreamId = 0;

// Promise chain that serializes long-running actions (INIT/GENERATE/DISPOSE).
// ABORT stays out of this chain — it's a synchronous id bump and MUST land
// immediately so a running stream loop can observe the change on its next
// iteration. Without serialization, two concurrent GENERATEs would each
// build their own `tts.stream(splitter, ...)` and run inference in parallel,
// burning CPU on a stream we already abandoned.
let actionChain = Promise.resolve();

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  // ABORT is special: it must take effect on the next yield of the
  // currently-running for-await loop. If we queued it behind the GENERATE
  // it's trying to abort, the GENERATE would never see the bump and the
  // loop would never exit early.
  if (msg.action === 'ABORT') {
    activeStreamId++;
    return;
  }
  // PING is deliberately handled OUTSIDE actionChain, exactly like ABORT.
  // Its whole purpose is to answer while the chain is blocked — if it queued
  // behind a wedged link it would tell us nothing. A PONG proves the worker's
  // event loop is alive; the absence of one proves it is dead or fully wedged.
  // That distinction is the only thing separating "an inference promise never
  // resolved" from "the browser OOM-killed us", and both look identical from
  // the manager otherwise.
  //
  // The nonce is echoed so the manager can discard a late PONG from an
  // earlier check rather than treating it as proof of current liveness.
  if (msg.action === 'PING') {
    self.postMessage({
      event: 'PONG',
      activeStreamId: activeStreamId,
      hasTts: !!tts,
      nonce: msg.nonce
    });
    return;
  }
  actionChain = actionChain.then(async () => {
    try {
      switch (msg.action) {
        case 'INIT':
          await handleInit(msg.voice);
          break;
        case 'GENERATE': {
          // Adopt the manager-supplied streamId verbatim so the chunks we
          // post echo back the *same* id the manager's listener is filtering
          // on. We can't use Math.max(activeStreamId, msg.streamId) here:
          // every ABORT bumps activeStreamId on the worker side, but the
          // manager's counter only increments on generate(). After a Stop
          // press, activeStreamId runs ahead of msg.streamId, max() picks
          // the worker's higher number, chunks get tagged with that, and
          // the manager filters every one of them out — surfacing as a 90 s
          // "Generation timed out". Fallback to ++activeStreamId only for
          // older callers / direct unit tests that don't supply a streamId.
          const myId = (typeof msg.streamId === 'number')
            ? (activeStreamId = msg.streamId)
            : ++activeStreamId;
          await handleGenerate(msg.text, msg.voice, msg.speed, myId);
          break;
        }
        default:
          // Unknown action - ignore silently
          break;
      }
    } catch (err) {
      self.postMessage({ event: 'ERROR', message: err && err.message ? err.message : String(err) });
    }
  });
});

async function handleInit(warmupVoice) {
  if (tts) {
    // Already initialized. Don't re-run warmup (it's a 1-time cost).
    self.postMessage({ event: 'READY' });
    return;
  }

  // Reuse the in-flight load if one is already running. The actionChain
  // serializes top-level messages, but handleGenerate ALSO calls handleInit
  // when a GENERATE arrives before the very first INIT completes. Without
  // sharing the promise, that nested call would re-enter from_pretrained
  // and load the 92 MB ONNX graph twice.
  if (initPromise) {
    await initPromise;
    self.postMessage({ event: 'READY' });
    return;
  }

  initPromise = (async () => {
    // Only `dtype` and `device` are passed, because they are the only two
    // options that survive the trip.
    //
    // We used to also pass a session_options object here. It never did
    // anything. kokoro-js's wrapper is:
    //
    //   static async from_pretrained(id, {dtype = "fp32", device = null,
    //                                     progress_callback = null} = {}) {
    //     const n = StyleTextToSpeech2Model.from_pretrained(id,
    //                 {progress_callback, dtype, device}), ...
    //
    // — it destructures exactly three options and forwards exactly those
    // three. Anything else, session_options included, is dropped before it
    // reaches transformers.js, so it never reaches
    // ort.InferenceSession.create either. The old comment here claimed we
    // were deliberately pinning graphOptimizationLevel / executionMode /
    // enableMemPattern / enableCpuMemArena against version drift; none of
    // that was happening.
    //
    // Losing it costs close to nothing: ORT-web already defaults
    // graphOptimizationLevel to 'all' and enableMemPattern /
    // enableCpuMemArena to true, which is what we were asking for. The
    // options that are genuinely out of reach are freeDimensionOverrides,
    // intraOpNumThreads / interOpNumThreads, and logSeverityLevel.
    //
    // Getting them back would mean patching the vendored bundle — the
    // wrapper can't be bypassed from here, because kokoro.web.js exports
    // only KokoroTTS, TextSplitterStream and env, so the underlying
    // transformers.js model class (which DOES accept session_options) isn't
    // reachable. Not worth a fork for the expected gain; revisit only if
    // profiling points at one of those three specifically.
    const loaded = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: MODEL_DTYPE,
      device: 'wasm'
    });

    // Warmup pass: ORT compiles per-kernel code on its first execute, which
    // adds ~0.5–2 s on the user's first click. Running a tiny throwaway
    // generate here folds that cost into the prewarm window. Also fetches
    // the user's voice embedding (~511 KB) so the first real read doesn't
    // pay that round-trip either. The JIT cost is voice-independent, so the
    // af_heart fallback still benefits every voice the user might pick.
    const stripped = (typeof warmupVoice === 'string' && warmupVoice.length > 0)
      ? warmupVoice.replace(/^ai:/, '')
      : 'af_heart';
    try {
      await loaded.generate('a', { voice: stripped, speed: 1.0 });
      console.log('[GlowReadTTS] Kokoro warmup complete (voice: ' + stripped + ')');
    } catch (e) {
      // Warmup is best-effort; failure here doesn't block READY. Real reads
      // still work, just paying the JIT cost on first click.
      console.warn('[GlowReadTTS] Warmup generate failed (non-fatal):', e && e.message ? e.message : e);
    }

    // Publish the loaded instance only after warmup so callers that observe
    // `tts` directly never see a half-initialized model.
    tts = loaded;

    const threads = (env.backends && env.backends.onnx && env.backends.onnx.wasm && env.backends.onnx.wasm.numThreads) || 1;
    console.log('[GlowReadTTS] Kokoro initialized on WASM (' + threads + ' threads)');
  })().catch(err => {
    // Don't cache a rejected promise — a transient failure shouldn't poison
    // every later INIT/GENERATE. Caller can retry.
    initPromise = null;
    throw err;
  });

  await initPromise;
  self.postMessage({ event: 'READY' });
}

/**
 * Normalize incoming text before handing it to Kokoro's TextSplitterStream.
 * Real-world text (right-click selections from random sites, paste from
 * Word/Slack/Substack/etc.) sometimes contains:
 *   - zero-width characters that confuse the segmenter
 *   - runaway whitespace from soft-wrapped paragraphs
 *   - no terminal punctuation, which can cause the splitter to strand the
 *     last fragment and never yield it before close()
 * Cleaning this once up front makes segmentation predictable and prevents
 * the "audio starts mid-selection" / "last sentence missing" failure modes.
 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  // Strip zero-width characters: ZWSP, ZWNJ, ZWJ, BOM.
  text = text.replace(/[​-‍﻿]/g, '');
  // Normalize line endings (Windows / old Mac).
  text = text.replace(/\r\n?/g, '\n');
  // Collapse 3+ newlines to a single paragraph break.
  text = text.replace(/\n{3,}/g, '\n\n');
  // Collapse runs of spaces and tabs within a line.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.trim();
  // Append terminal punctuation if missing so the splitter yields the
  // final fragment instead of buffering it forever.
  if (text.length > 0 && !/[.!?]$/.test(text)) {
    text += '.';
  }
  return text;
}

async function handleGenerate(text, voice, speed, myId) {
  if (!tts) {
    await handleInit(voice);
    if (myId !== activeStreamId) return; // aborted during cold init
  }
  if (!text || typeof text !== 'string') {
    throw new Error('No text supplied for generation');
  }

  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    throw new Error('No text supplied for generation');
  }

  const resolvedVoice = voice || 'af_heart';
  const resolvedSpeed = typeof speed === 'number' ? speed : 1.0;

  // We deliberately drive the splitter ourselves instead of letting
  // tts.stream(text, {split_pattern}) build an internal one. The bundled
  // kokoro lib's stream() never calls .close() on the splitter it creates
  // when you pass a string, so its async iterator awaits forever after
  // consuming all queued sentences — AUDIO_DONE is never posted, the
  // popup UI hangs in "Reading..." until the manager's 90 s timeout fires
  // an ERROR. By owning the TextSplitterStream we can push the text and
  // immediately close() it, so the iterator terminates cleanly when the
  // last yielded sentence is done.
  //
  // We also push the raw text rather than pre-splitting, so kokoro's own
  // sentence segmenter (which handles abbreviations / URLs / ellipses
  // better than a simple regex) does the work. close() flushes any
  // trailing text that didn't end on a sentence terminator.
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, {
    voice: resolvedVoice,
    speed: resolvedSpeed
  });
  splitter.push(normalizedText);
  splitter.close();

  // Index of the chunk within this stream. Each chunk is exactly one of
  // Kokoro's TextSplitterStream sentences, so this is also the sentence
  // index. The content script uses (sentenceText, sentenceIndex) to land
  // the highlight on the matching page sentence the moment audio for that
  // chunk starts.
  let sentenceIdx = 0;
  for await (const chunk of stream) {
    if (myId !== activeStreamId) {
      // Newer GENERATE or an ABORT has fired; drop this chunk and any
      // remaining inference cost is sunk.
      return;
    }
    const trimmedPcm = trimSilence(chunk.audio.audio, chunk.audio.sampling_rate);
    const wavBuffer = encodeWav(trimmedPcm, chunk.audio.sampling_rate);
    const sentenceText = (typeof chunk.text === 'string') ? chunk.text : '';
    self.postMessage(
      {
        event: 'AUDIO_CHUNK',
        streamId: myId,
        audioBuffer: wavBuffer,
        sentenceText: sentenceText,
        sentenceIndex: sentenceIdx
      },
      [wavBuffer]
    );
    sentenceIdx++;
  }

  if (myId === activeStreamId) {
    self.postMessage({ event: 'AUDIO_DONE', streamId: myId });
  }
}

/**
 * Drop both the silent head and silent tail of a Kokoro chunk before encoding.
 *
 * The model's decoder lets each sentence's final phoneme decay to silence
 * over 50–200ms, and prepends a smaller leading silence. The manager now
 * stitches chunks gaplessly through Web Audio scheduling, so any silence
 * baked into the WAVs at the boundary is the ENTIRE remaining inter-sentence
 * pause — get this number low. Walk inward while samples are below -40 dBFS
 * (~0.01 in normalized float) and keep ~1ms on each side so consonant
 * onsets/releases don't sound chopped.
 *
 * Threshold sits below the quietest speech (sibilant tails ~-25 to -30
 * dBFS, regular speech -10 to -20 dBFS) but above genuine silence and
 * model-generated fades, so the trim catches Kokoro's natural sentence-
 * end fade-out without clipping audible content. Combined with the
 * 5ms chunk overlap in ChunkedAudio._scheduleChunk, this tightens
 * inter-sentence pacing by ~15-35ms per boundary.
 *
 * If the entire chunk is below threshold (model glitch), we leave it
 * alone rather than emit an empty WAV.
 */
function trimSilence(pcm, sampleRate) {
  if (!pcm || pcm.length === 0) return pcm;
  const threshold = 0.01;
  const bufferSamples = Math.floor(sampleRate * 1 / 1000);
  let end = pcm.length;
  while (end > 0 && Math.abs(pcm[end - 1]) < threshold) end--;
  if (end === 0) return pcm;
  let start = 0;
  while (start < end && Math.abs(pcm[start]) < threshold) start++;
  start = Math.max(0, start - bufferSamples);
  end = Math.min(pcm.length, end + bufferSamples);
  return pcm.subarray(start, end);
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
