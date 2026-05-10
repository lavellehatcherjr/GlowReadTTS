/**
 * Manages the AI voice inference Web Worker and audio playback.
 *
 * Spawns the inference worker lazily, relays GENERATE messages, and owns
 * the AudioContext-backed playback queue (ChunkedAudio) so pause / resume /
 * stop work without coordination with the consumer.
 */

// Cold-load includes WASM compile + 92 MB ONNX graph parse plus a 1-token
// warmup generate on the first call; subsequent generates only run inference.
// INIT_TIMEOUT_MS covers init + warmup. GENERATE_TIMEOUT_MS bounds the wait
// between successive AUDIO_CHUNK posts (it resets on each chunk), not the
// total stream duration — that way long paragraphs don't trip the timer
// while a hung worker still surfaces as a real reject instead of a hung
// channel. 90 s per-chunk is generous; per-sentence inference on 4-thread
// WASM is typically 0.5–2 s.
const INIT_TIMEOUT_MS = 60_000;
const GENERATE_TIMEOUT_MS = 90_000;

/**
 * AudioContext-backed playback queue. Exposes a small EventTarget surface
 * (play, pause, dispose, plus 'timeupdate', 'ended', 'error', 'sentencestart'
 * events) that the consumer (offscreen.js) wires up just like an
 * HTMLAudioElement.
 *
 * Each Kokoro chunk is decoded to an AudioBuffer and scheduled with
 * source.start(when), where `when` is the previous chunk's exact end-time
 * in ctx-time — so inter-sentence playback is sample-accurate gapless,
 * not subject to the <Audio>-element hand-off pause Chromium imposes.
 *
 * Decode runs in parallel for incoming chunks, but scheduling is
 * serialized via a chained promise so chunks always play in the order
 * the worker postMessaged them, even if a later chunk's decode finishes
 * sooner.
 */
class ChunkedAudio extends EventTarget {
  constructor(estimatedDurationSec) {
    super();
    // Single AudioContext for the whole stream. Scheduling chunks by
    // ctx-time gives gapless playback that <Audio> elements can't.
    const Ctor = (typeof self !== 'undefined' && (self.AudioContext || self.webkitAudioContext))
      || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
      || AudioContext;
    this._ctx = new Ctor();
    // Gain node lets us swap a fade-out in later if we ever need to mute
    // a stop without an audible click. For now it's just unity gain.
    this._gain = this._ctx.createGain();
    this._gain.connect(this._ctx.destination);

    // Scheduled but not-yet-finished chunks, in playback order.
    this._scheduled = [];
    // Decoded chunks waiting for play() before scheduling.
    this._queued = [];
    // Promise chain that serializes scheduling; addChunk awaits it before
    // calling source.start so out-of-order decode completion can't reorder
    // playback.
    this._chainTail = Promise.resolve();

    // ctx-time at which the next chunk should begin. -1 = none scheduled yet.
    this._nextStartTime = -1;
    // ctx-time at which chunk 0 was scheduled; used as the zero of currentTime.
    this._firstStartTime = -1;
    this._totalScheduledDuration = 0;

    this._streamDone = false;
    this._ended = false;
    this._paused = true;
    this._estimated = Math.max(0.5, estimatedDurationSec || 0.5);
    this._disposed = false;

    // Metadata of the chunk currently playing — { text, index } supplied
    // by the worker. Consumer reads `currentSentenceMeta` after attaching
    // its 'sentencestart' listener to recover the chunk-0 event that
    // typically fires before subscription.
    this._currentSentenceMeta = null;

    // Watchdog heartbeat: a 5 s 'timeupdate' tick while playing. The
    // offscreen relays this to the content script's highlight watchdog
    // (60 s no-update timeout) so an orphan highlight doesn't linger if
    // the driver is torn down. 5 s is well under the watchdog window AND
    // 200x cheaper than the prior 100 ms cadence, which was originally
    // sized for char-based progress (now removed in favor of chunk-
    // boundary sentence-start signals).
    this._timeUpdateTimer = null;
  }

  get currentSentenceMeta() { return this._currentSentenceMeta; }

  get duration() {
    if (this._streamDone && this._totalScheduledDuration > 0) {
      return this._totalScheduledDuration;
    }
    return this._estimated;
  }

  get currentTime() {
    if (this._firstStartTime < 0) return 0;
    return Math.max(0, this._ctx.currentTime - this._firstStartTime);
  }

  get paused() { return this._paused; }

  /**
   * Add a Kokoro chunk to the stream. Takes the raw WAV ArrayBuffer from
   * the worker. Decode kicks off immediately (in parallel with sibling
   * chunks); scheduling waits behind the prior chunk on a serial chain.
   *
   * @param {ArrayBuffer} rawWavBuffer
   * @param {{text: string, index: number}|null} [sentenceMeta]
   */
  addChunk(rawWavBuffer, sentenceMeta) {
    if (this._disposed) return;
    const decodePromise = this._ctx.decodeAudioData(rawWavBuffer);
    this._chainTail = this._chainTail.then(async () => {
      if (this._disposed) return;
      let buffer;
      try {
        buffer = await decodePromise;
      } catch (e) {
        try { this.dispatchEvent(new Event('error')); } catch (ee) { /* ignore */ }
        return;
      }
      if (this._disposed) return;
      if (this._paused) {
        this._queued.push({ buffer, sentenceMeta: sentenceMeta || null });
      } else {
        this._scheduleChunk(buffer, sentenceMeta || null);
      }
    });
  }

  _scheduleChunk(buffer, sentenceMeta) {
    if (this._disposed) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;
    // Schedule each subsequent chunk to begin 5 ms BEFORE the previous
    // chunk's nominal end. Combined with the worker's silence trim
    // (which keeps ~1 ms of buffer on each side), the overlap region is
    // mostly trimmed-but-buffered silence. Net effect: ~5 ms tighter
    // pacing per boundary on top of the silence trim. Compounds across
    // a multi-sentence read (~5 ms × (N-1) saved over N sentences).
    // Never schedules in the past (clamped to `now`) and never overlaps
    // chunk 0 (no previous chunk to overlap into).
    const CHUNK_OVERLAP_SEC = 0.005;
    const when = (this._nextStartTime < 0)
      ? now
      : Math.max(now, this._nextStartTime - CHUNK_OVERLAP_SEC);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this._gain);
    source.start(when);

    if (this._firstStartTime < 0) this._firstStartTime = when;

    const entry = {
      source: source,
      when: when,
      duration: buffer.duration,
      sentenceMeta: sentenceMeta,
      sentenceTimer: null
    };

    // Fire 'sentencestart' the moment this chunk transitions to the active
    // chunk. setTimeout's drift relative to ctx.currentTime is small at
    // sub-second delays — well within a sentence highlight's tolerance.
    const delayMs = Math.max(0, (when - now) * 1000);
    entry.sentenceTimer = setTimeout(() => {
      if (this._disposed) return;
      this._currentSentenceMeta = sentenceMeta;
      if (sentenceMeta) {
        try {
          this.dispatchEvent(new CustomEvent('sentencestart', { detail: sentenceMeta }));
        } catch (e) { /* CustomEvent always works in browsers; defensive */ }
      }
    }, delayMs);

    source.onended = () => {
      if (this._disposed) return;
      // The 'ended' event for the queue fires only when the LAST scheduled
      // chunk's source ends AND the worker has marked the stream done.
      const isLast = (this._scheduled[this._scheduled.length - 1] === entry);
      if (this._streamDone && isLast) {
        this._fireEnded();
      }
    };

    this._scheduled.push(entry);
    this._nextStartTime = when + buffer.duration;
    this._totalScheduledDuration += buffer.duration;
  }

  play() {
    if (this._disposed) return Promise.resolve();
    const wasPaused = this._paused;
    this._paused = false;

    // Promote any pre-play queued chunks into the schedule. After this,
    // future addChunk calls schedule immediately (since !paused).
    while (this._queued.length > 0) {
      const item = this._queued.shift();
      this._scheduleChunk(item.buffer, item.sentenceMeta);
    }

    let resumePromise = Promise.resolve();
    if (this._ctx.state === 'suspended') {
      // Autoplay policies may keep the context suspended until a user
      // gesture; in extension offscreen contexts AUDIO_PLAYBACK reason
      // grants permission, so this normally succeeds. Failure is non-fatal
      // — the audio just won't play and the consumer's error path runs.
      resumePromise = this._ctx.resume().catch(() => {});
    }

    if (wasPaused) this._startTimeUpdates();
    return resumePromise;
  }

  pause() {
    if (this._paused || this._disposed) return;
    this._paused = true;
    if (this._ctx.state === 'running') {
      this._ctx.suspend().catch(() => {});
    }
    this._stopTimeUpdates();
  }

  _startTimeUpdates() {
    if (this._timeUpdateTimer !== null) return;
    this._timeUpdateTimer = setInterval(() => {
      if (this._paused || this._disposed) return;
      try { this.dispatchEvent(new Event('timeupdate')); } catch (e) { /* ignore */ }
    }, 5000);
  }

  _stopTimeUpdates() {
    if (this._timeUpdateTimer !== null) {
      clearInterval(this._timeUpdateTimer);
      this._timeUpdateTimer = null;
    }
  }

  /**
   * Signal that no more chunks will arrive. If we've already played every
   * scheduled chunk past its end-time, fire 'ended' now.
   */
  markStreamDone() {
    this._streamDone = true;
    if (this._scheduled.length === 0 && this._queued.length === 0) {
      this._fireEnded();
      return;
    }
    if (this._scheduled.length > 0) {
      const last = this._scheduled[this._scheduled.length - 1];
      if (this._ctx.currentTime >= last.when + last.duration) {
        this._fireEnded();
      }
    }
  }

  _fireEnded() {
    if (this._ended || this._disposed) return;
    this._ended = true;
    this._stopTimeUpdates();
    try { this.dispatchEvent(new Event('ended')); } catch (e) { /* ignore */ }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stopTimeUpdates();
    for (const entry of this._scheduled) {
      try { entry.source.stop(); } catch (e) { /* ignore */ }
      try { entry.source.disconnect(); } catch (e) { /* ignore */ }
      if (entry.sentenceTimer !== null) clearTimeout(entry.sentenceTimer);
    }
    this._scheduled = [];
    this._queued = [];
    try { this._gain.disconnect(); } catch (e) { /* ignore */ }
    try { this._ctx.close(); } catch (e) { /* ignore */ }
  }
}

class KokoroManager {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.audio = null;
    this._initPromise = null;
    // Tear-down for the most recent in-flight generate(). Lets stop() and a
    // subsequent generate() supersede an earlier one without leaking message
    // listeners and without two generate handlers fighting over chunks the
    // worker emits after activeStreamId moved on.
    this._activeAbort = null;
    // Monotonic counter stamped onto each GENERATE we send. The worker echoes
    // it back on every AUDIO_CHUNK / AUDIO_DONE; the listener drops anything
    // whose streamId doesn't match its own. Without this, a chunk that was
    // already mid-flight on the worker thread when we posted ABORT can leak
    // into the *next* generate's listener and play as the first chunk of the
    // new read — which is exactly the "stop didn't stop, it kept reading the
    // old text" bug.
    this._streamIdCounter = 0;
  }

  /**
   * Generate speech and start playback as soon as the first sentence is ready.
   * Resolves with a ChunkedAudio queue once the first chunk's `play()`
   * succeeds — so consumers can attach timeupdate / ended / sentencestart
   * listeners and they fire over the entire stream, not just chunk 1.
   */
  async generate(text, voice, speed) {
    if (!this.ready) {
      await this._init(voice);
    }

    // Supersede any prior in-flight generate (and any prior playing audio).
    // stop() removes the prior listener, disposes its ChunkedAudio, posts
    // ABORT to the worker, and rejects the prior promise with AbortError if
    // it was still pending. This is the single point that guarantees only
    // one generate listener is wired into the worker at a time — without it
    // a second generate's chunks would also fire the first's handler.
    this.stop();

    // ~15 chars/sec is a rough Kokoro speaking rate at speed=1.0; speed
    // shortens proportionally. This is only used as a hint while the stream
    // is in flight (so highlight progress relays don't reject on infinite
    // duration). Replaced by the real summed duration once AUDIO_DONE.
    const safeSpeed = Math.max(0.25, Math.min(2.0, speed || 1.0));
    const estimatedSec = Math.max(0.5, (text.length / 15) / safeSpeed);

    const myStreamId = ++this._streamIdCounter;

    return new Promise((resolve, reject) => {
      const chunked = new ChunkedAudio(estimatedSec);
      let resolvedFirst = false;
      let timer = null;

      const cleanup = () => {
        if (this.worker) {
          this.worker.removeEventListener('message', handler);
          this.worker.removeEventListener('error', errorHandler);
          this.worker.removeEventListener('messageerror', errorHandler);
        }
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (this._activeAbort === abortFn) this._activeAbort = null;
      };
      const abortFn = () => {
        cleanup();
        chunked.dispose();
        if (!resolvedFirst) {
          // Use a DOMException-flavored AbortError so callers can tell
          // user-stop / supersession apart from real failures with
          // `err.name === 'AbortError'`.
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        }
        // If we already resolved, the consumer owns `chunked` and its
        // 'ended' / 'error' events; we've already disposed it above so
        // playback won't continue.
      };
      this._activeAbort = abortFn;

      const armTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          if (!resolvedFirst) {
            chunked.dispose();
            reject(new Error('Generation timed out after ' + GENERATE_TIMEOUT_MS + 'ms'));
          } else {
            // Stream has stalled mid-playback. Surface as an error event so
            // the consumer's error handler tears down the UI; don't reject
            // the original promise (it already resolved on chunk 1).
            chunked.dispatchEvent(new Event('error'));
          }
        }, GENERATE_TIMEOUT_MS);
      };

      const handler = (e) => {
        const data = e.data || {};
        // Drop events that belong to a previous (aborted/superseded) stream.
        // The worker stamps streamId on every AUDIO_CHUNK / AUDIO_DONE; a
        // chunk emitted after we posted ABORT but before the worker reached
        // its next yield can still arrive here, and without this guard it
        // would be queued as the *new* generate's first chunk — i.e. the
        // user clicks Stop and immediately starts a new read, but hears the
        // tail end of the old text instead.
        if (typeof data.streamId === 'number' && data.streamId !== myStreamId) {
          return;
        }
        if (data.event === 'AUDIO_CHUNK') {
          armTimer();

          // Worker-supplied per-chunk metadata. ChunkedAudio uses this to
          // dispatch a 'sentencestart' event when this chunk begins playing,
          // which the offscreen relays to the page so the highlight lands
          // exactly on the audio sentence boundary.
          const sentenceMeta = (typeof data.sentenceText === 'string' && data.sentenceText.length > 0)
            ? { text: data.sentenceText, index: data.sentenceIndex }
            : null;

          // Hand the raw WAV ArrayBuffer to ChunkedAudio. It owns the
          // decode → AudioBuffer → BufferSource pipeline and schedules
          // sample-accurate gapless playback against the previous chunk's
          // end-time, so the inter-sentence pause that <Audio>-element
          // hand-off used to introduce is gone.
          if (!resolvedFirst) {
            resolvedFirst = true;
            this.audio = chunked;
            chunked.addChunk(data.audioBuffer, sentenceMeta);
            chunked.play().then(
              () => resolve(chunked),
              err => {
                cleanup();
                chunked.dispose();
                reject(err);
              }
            );
          } else {
            chunked.addChunk(data.audioBuffer, sentenceMeta);
          }
        } else if (data.event === 'AUDIO_DONE') {
          cleanup();
          chunked.markStreamDone();
          if (!resolvedFirst) {
            // Stream ended without yielding any audio (e.g. all-whitespace
            // input). Surface as a real reject so the caller can fall back.
            chunked.dispose();
            reject(new Error('Stream completed with no audio'));
          }
        } else if (data.event === 'ERROR') {
          cleanup();
          if (!resolvedFirst) {
            chunked.dispose();
            reject(new Error(data.message));
          } else {
            // Already playing some chunks; let the consumer's 'error'
            // handler tear it down through the same path as a chunk error.
            chunked.dispatchEvent(new Event('error'));
          }
        }
      };
      const errorHandler = (e) => {
        cleanup();
        const msg = (e && (e.message || e.filename)) || 'unknown worker error';
        if (!resolvedFirst) {
          chunked.dispose();
          reject(new Error('worker error during generate: ' + msg));
        } else {
          chunked.dispatchEvent(new Event('error'));
        }
      };

      armTimer();
      this.worker.addEventListener('message', handler);
      this.worker.addEventListener('error', errorHandler);
      this.worker.addEventListener('messageerror', errorHandler);
      this.worker.postMessage({ action: 'GENERATE', text: text, voice: voice, speed: speed, streamId: myStreamId });
    });
  }

  pause() { if (this.audio && !this.audio.paused) this.audio.pause(); }

  resume() { if (this.audio && this.audio.paused) this.audio.play(); }

  stop() {
    if (this.audio) {
      try { this.audio.pause(); } catch (e) { /* ignore */ }
      // ChunkedAudio.dispose() stops every scheduled BufferSource and
      // closes the AudioContext, atomically tearing down the stream.
      try { this.audio.dispose(); } catch (e) { /* ignore */ }
      this.audio = null;
    }
    // Tear down any in-flight generate so its listener detaches and its
    // promise rejects with AbortError (if still pending). Without this,
    // the next generate() would race against the prior handler over
    // AUDIO_CHUNK events emitted before the worker observed our ABORT.
    if (this._activeAbort) {
      const abortFn = this._activeAbort;
      this._activeAbort = null;
      abortFn();
    }
    // Tell the worker to bail out of any in-flight stream loop so it
    // stops posting AUDIO_CHUNK messages we'd just discard. Idempotent
    // when no stream is active.
    if (this.worker) {
      try { this.worker.postMessage({ action: 'ABORT' }); } catch (e) { /* ignore */ }
    }
  }

  _ensureWorker() {
    if (!this.worker) {
      const url = chrome.runtime.getURL('libs/kokoro/kokoro-worker.js');
      this.worker = new Worker(url, { type: 'module' });
    }
  }

  /**
   * Initialize the worker. The optional `voice` is forwarded so the worker's
   * post-load warmup pass loads that voice's embedding too — making the
   * user's first real read pay zero voice-fetch cost on top of zero
   * first-execute JIT cost. Works for every AI voice we ship; the worker
   * falls back to af_heart if `voice` is missing.
   */
  async _init(voice) {
    this._ensureWorker();
    if (!this._initPromise) {
      this._initPromise = new Promise((resolve, reject) => {
        const cleanup = () => {
          this.worker.removeEventListener('message', handler);
          this.worker.removeEventListener('error', errorHandler);
          this.worker.removeEventListener('messageerror', errorHandler);
          clearTimeout(timer);
        };
        const handler = (e) => {
          const data = e.data || {};
          if (data.event === 'READY') {
            cleanup();
            this.ready = true;
            resolve();
          } else if (data.event === 'ERROR') {
            cleanup();
            reject(new Error(data.message));
          }
        };
        const errorHandler = (e) => {
          cleanup();
          // A worker `error` event fires when the worker script fails to load
          // or throws at top level (e.g., WASM module instantiation failure).
          // Without this listener the init promise would hang forever and the
          // SW↔offscreen message channel would close with the opaque
          // "channel closed" error.
          const msg = (e && (e.message || e.filename)) || 'unknown worker error';
          reject(new Error('worker error during init: ' + msg));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Model init timed out after ' + INIT_TIMEOUT_MS + 'ms'));
        }, INIT_TIMEOUT_MS);
        this.worker.addEventListener('message', handler);
        this.worker.addEventListener('error', errorHandler);
        this.worker.addEventListener('messageerror', errorHandler);
        this.worker.postMessage({ action: 'INIT', voice: voice });
      }).catch(err => {
        // Don't cache a rejected promise — a transient failure shouldn't
        // poison every subsequent generate() call. Caller can retry.
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }
}

export default KokoroManager;
