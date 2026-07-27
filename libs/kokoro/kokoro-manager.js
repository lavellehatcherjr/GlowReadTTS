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

// Bound on the wait for the FIRST chunk, as distinct from the gap between
// later chunks. GENERATE_TIMEOUT_MS used to cover both, which meant a worker
// that never answered at all took 90 s to surface — and held its AudioContext
// and decoded buffers for that whole window. Nothing legitimate takes 15 s to
// produce one sentence of audio on a warm session: at 4-thread WASM a sentence
// is 0.5–2 s, and cold-load cost is paid in _init(), not here. So a 15 s
// silence means the worker is wedged or dead, and we say so instead of waiting.
const FIRST_CHUNK_TIMEOUT_MS = 15_000;

// Deadline for the pre-generate liveness probe. This is a bare postMessage
// round trip on an idle worker — sub-millisecond when healthy. 2 s is
// generous enough to absorb a busy main thread without ever tripping on a
// worker that is merely slow.
const PING_TIMEOUT_MS = 2_000;

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
    // close() returns a promise; the surrounding try/catch only catches a
    // synchronous throw (e.g. _ctx already gone), so a rejection would escape
    // as an unhandled rejection and clutter exactly the console we need to
    // read when diagnosing a wedged worker.
    try { this._ctx.close().catch(() => {}); } catch (e) { /* ignore */ }
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

    // Set by _onWorkerFatal when the worker fires `error` / `messageerror`.
    // A non-null `this.worker` is NOT proof of life — a Worker whose thread
    // has been terminated still presents as a live object and postMessage to
    // it neither throws nor delivers — so this flag plus _pingWorker() are
    // the only two ways we ever learn the worker is gone.
    this._workerDead = false;

    // Monotonic nonce for liveness probes, so a late PONG from an earlier
    // probe can't be mistaken for proof that the worker is alive now.
    this._pingNonce = 0;

    // Bound once so add/removeEventListener reference the same function.
    // These listeners are attached at worker creation and are deliberately
    // NEVER removed by any cleanup() — the per-call error handlers in
    // generate()/_init() are correctly torn down with their promises, which
    // used to leave the worker completely unobserved between reads.
    this._onWorkerFatal = (e) => {
      const msg = (e && (e.message || e.filename)) || 'unknown worker error';
      console.error('[GlowReadTTS] Fatal worker event:', msg);
      this._workerDead = true;
    };
  }

  /**
   * Ask the worker whether it is alive. Resolves with the PONG payload, or
   * null on timeout / no worker. Never rejects — callers branch on null.
   *
   * PING is answered outside the worker's actionChain, so a PONG means the
   * event loop is running even if the chain is blocked behind an inference
   * that will never settle. A missing PONG means the worker is dead or fully
   * wedged. Either way the session is unusable, but the reason is logged so
   * the underlying bug stays diagnosable.
   */
  _pingWorker(timeoutMs = PING_TIMEOUT_MS) {
    if (!this.worker || this._workerDead) return Promise.resolve(null);

    const nonce = ++this._pingNonce;
    const worker = this.worker;

    return new Promise((resolve) => {
      let timer = null;
      // Guards against the listener and the timer both firing — whichever
      // lands first wins and the other becomes a no-op.
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { worker.removeEventListener('message', onMessage); } catch (e) { /* ignore */ }
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(value);
      };

      const onMessage = (e) => {
        const data = e.data || {};
        // Ignore everything that isn't OUR pong. A generate() may be
        // streaming concurrently, so this listener sees AUDIO_CHUNK traffic
        // too; and a stale pong from a previous probe proves nothing about
        // the worker's state now.
        if (data.event !== 'PONG' || data.nonce !== nonce) return;
        finish(data);
      };

      worker.addEventListener('message', onMessage);
      timer = setTimeout(() => finish(null), timeoutMs);

      try {
        worker.postMessage({ action: 'PING', nonce: nonce });
      } catch (e) {
        // postMessage on a dead worker doesn't normally throw, but if it
        // ever does, don't wait out the deadline for an answer.
        finish(null);
      }
    });
  }

  /**
   * Tear down a worker we can no longer trust and reset state so the next
   * generate() rebuilds from scratch. Safe to call when the worker is already
   * dead — terminate() on a terminated Worker is a no-op.
   *
   * Resetting `ready` and `_initPromise` is the whole point: without them
   * generate() would keep skipping _init() (`if (!this.ready)`) and _init()
   * would keep returning its cached resolved promise, so a replacement worker
   * would be spawned but never actually INIT'd.
   */
  _recycleWorker(reason) {
    // Loud on purpose. Recovering from this is not the same as fixing it —
    // every occurrence is the underlying accumulation bug happening again,
    // and the reason string is what distinguishes a wedged chain (PONG
    // received, no chunks) from a dead worker (no PONG at all).
    console.warn('[GlowReadTTS] Worker unresponsive (' + reason + '), recycling');

    if (this.audio) {
      try { this.audio.dispose(); } catch (e) { /* ignore */ }
      this.audio = null;
    }
    // Settle any in-flight generate so its caller gets an AbortError instead
    // of hanging on a promise whose worker no longer exists.
    if (this._activeAbort) {
      const abortFn = this._activeAbort;
      this._activeAbort = null;
      try { abortFn(); } catch (e) { /* ignore */ }
    }

    if (this.worker) {
      try { this.worker.removeEventListener('error', this._onWorkerFatal); } catch (e) { /* ignore */ }
      try { this.worker.removeEventListener('messageerror', this._onWorkerFatal); } catch (e) { /* ignore */ }
      try { this.worker.terminate(); } catch (e) { /* ignore */ }
    }

    this.worker = null;
    this.ready = false;
    this._initPromise = null;
    // Clear for the replacement worker — otherwise _ensureWorker() would
    // immediately recycle the fresh one it just spawned.
    this._workerDead = false;
  }

  /**
   * Generate speech and start playback as soon as the first sentence is ready.
   * Resolves with a ChunkedAudio queue once the first chunk's `play()`
   * succeeds — so consumers can attach timeupdate / ended / sentencestart
   * listeners and they fire over the entire stream, not just chunk 1.
   */
  async generate(text, voice, speed) {
    // Liveness gate. Only worth a round trip when we believe we're already
    // initialised — if `ready` is false the worker is about to be built and
    // INIT'd anyway, and pinging a worker mid-cold-load would just time out
    // against a thread legitimately busy compiling 20 MB of WASM.
    //
    // On no answer we recycle rather than fail: `ready` drops to false, the
    // block below rebuilds, and the read completes after a cold load instead
    // of posting into the void and waiting out a timeout. That is what turns
    // "broken until the extension is reloaded" into "one slow read".
    //
    // Deliberately placed before `_activeAbort` is assigned further down, so
    // _recycleWorker()'s teardown can't abort the very call that triggered it.
    if (this.ready) {
      const pong = await this._pingWorker();
      if (!pong) {
        this._recycleWorker('no PONG within ' + PING_TIMEOUT_MS + 'ms');
      }
    }

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
      // Did we hear ANYTHING from the worker during this call? This is the
      // discriminator for whether a failure is worker-level (recycle) or
      // ordinary (don't). A worker that posted even one message — including a
      // stale-streamId one we filtered out, or an ERROR it reported itself —
      // is alive and talking, and throwing away its warm 92 MB session would
      // cost a 3–12 s cold load for nothing.
      let sawAnyResponse = false;

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

      // `waitingForFirstChunk` picks the deadline: 15 s while nothing has
      // arrived (a silent worker), 90 s for the gap between later chunks (a
      // long sentence on slow hardware, which is legitimate).
      const armTimer = (waitingForFirstChunk) => {
        if (timer !== null) clearTimeout(timer);
        const ms = waitingForFirstChunk ? FIRST_CHUNK_TIMEOUT_MS : GENERATE_TIMEOUT_MS;
        timer = setTimeout(() => {
          cleanup();
          if (!resolvedFirst) {
            chunked.dispose();
            if (!sawAnyResponse) {
              // Silence for the whole window with not one message back: the
              // worker is wedged or dead. Recycle so the NEXT read rebuilds
              // instead of repeating this.
              this._recycleWorker('no response within ' + ms + 'ms');
            }
            // Distinct from the mid-stream stall message below so the console
            // says which failure this was.
            reject(new Error(
              'No audio produced within ' + Math.round(ms / 1000) + 's' +
              (sawAnyResponse ? '' : ' (worker may be unresponsive)')
            ));
          } else {
            // Stream has stalled mid-playback. The worker demonstrably works
            // — it produced chunks — so this is NOT a recycle case. Surface
            // as an error event so the consumer's error handler tears down
            // the UI; don't reject the original promise (it already resolved
            // on chunk 1).
            chunked.dispatchEvent(new Event('error'));
          }
        }, ms);
      };

      const handler = (e) => {
        const data = e.data || {};
        // Set BEFORE the streamId filter below: any message at all proves the
        // worker's event loop is running, even one belonging to a superseded
        // stream. This is only ever used to decide "recycle or not", never to
        // decide what to play.
        sawAnyResponse = true;
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
          // A chunk arrived, so from here on we're bounding inter-chunk gaps,
          // not worker silence — back to the generous 90 s budget.
          armTimer(false);

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
        // A worker-level `error` / `messageerror` event means the worker
        // itself failed, not the generation — the session is not trustworthy
        // afterwards. Recycle unconditionally here, unlike the timeout path
        // which has to first rule out "worker is fine, just slow".
        this._recycleWorker('worker error event: ' + msg);
        if (!resolvedFirst) {
          chunked.dispose();
          reject(new Error('worker error during generate: ' + msg));
        } else {
          chunked.dispatchEvent(new Event('error'));
        }
      };

      // Nothing has arrived yet — arm the short first-chunk deadline.
      armTimer(true);
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
    // A non-null `this.worker` is NOT proof of life. A Worker whose thread has
    // been terminated — OOM-killed, or wedged inside WASM — still presents as
    // a live object, and postMessage to it neither throws nor delivers. So
    // this method cannot itself decide whether the worker is healthy.
    //
    // Liveness is established two ways, both outside here: _pingWorker()
    // before each generate(), and the permanent `error` listener below. Both
    // funnel into _recycleWorker(), which nulls this.worker — which is what
    // makes the null-check below a working respawn trigger rather than the
    // dead end it was.
    //
    // Kept synchronous on purpose: this is on the hot path and must not await
    // a probe.
    if (this.worker && this._workerDead) {
      this._recycleWorker('fatal worker error event');
    }
    if (!this.worker) {
      const url = chrome.runtime.getURL('libs/kokoro/kokoro-worker.js');
      this.worker = new Worker(url, { type: 'module' });
      this._workerDead = false;
      // Permanent, never removed by any cleanup(). The per-call handlers in
      // generate()/_init() are correctly torn down with their promises, which
      // left the worker entirely unobserved between reads — a worker that
      // died while idle went unnoticed until the next read timed out.
      this.worker.addEventListener('error', this._onWorkerFatal);
      this.worker.addEventListener('messageerror', this._onWorkerFatal);
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
          // Null-guarded because _recycleWorker() can now null this.worker
          // while an init is still in flight. generate()'s cleanup() has
          // always guarded this; before recycling existed, _init()'s couldn't
          // hit a null worker, and now it can.
          if (this.worker) {
            this.worker.removeEventListener('message', handler);
            this.worker.removeEventListener('error', errorHandler);
            this.worker.removeEventListener('messageerror', errorHandler);
          }
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
          // Worker-level failure during init — there is no warm session to
          // preserve, so drop it and let the next call build a fresh one.
          this._recycleWorker('worker error during init: ' + msg);
          reject(new Error('worker error during init: ' + msg));
        };
        const timer = setTimeout(() => {
          cleanup();
          // 60 s without a READY means the worker never finished loading the
          // model. There is no usable session to keep, so recycle rather than
          // leave a half-initialised worker that generate() would go on
          // pinging and rebuilding around.
          this._recycleWorker('init timed out after ' + INIT_TIMEOUT_MS + 'ms');
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
