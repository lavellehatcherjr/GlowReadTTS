/**
 * Offscreen document that owns a KokoroManager for the right-click context-menu
 * AI voice flow. The service worker can't host the inference worker or play
 * <Audio>, so it routes generation requests here. This document stays alive
 * for the browser session; the manager and worker persist across requests.
 *
 * API LIMIT, and it is a quiet one: chrome.runtime is the only extensions API
 * available inside an offscreen document. chrome.storage, chrome.tabs and the
 * rest are undefined here, so touching one throws a TypeError rather than
 * failing a call. Anything this document needs from another API has to be
 * asked of the service worker over chrome.runtime.
 * https://developer.chrome.com/docs/extensions/reference/api/offscreen
 */

import KokoroManager from '../libs/kokoro/kokoro-manager.js';

let manager = null;

// Track the tab whose highlight we're driving so handleStop can also clean up.
let currentTabId = null;

// Bumped every time a new run starts (handleGenerateAndPlay) or any teardown
// happens (handleStop). Each run captures its id at the top; its `onEnded`
// listener checks that the id is still current before posting OFFSCREEN_ENDED.
// Without this, when we dispose() the old ChunkedAudio while starting a new
// read, a stray 'error' event from the disposed AudioContext could otherwise
// round-trip through onEnded and tell the SW to STOP_HIGHLIGHT on the tab
// the NEW run just lit up, wiping it.
let activeRunId = 0;

// Heartbeat interval while a generation is in flight. The SW await on
// chrome.runtime.sendMessage normally keeps the SW alive, but a slow first
// cold-load of the WASM model can outlast Chrome's idle window. Each
// heartbeat is a real chrome.runtime.sendMessage round-trip, which resets
// that timer.
const HEARTBEAT_INTERVAL_MS = 20_000;
let heartbeatTimer = null;

function startHeartbeat(tabId) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      chrome.runtime.sendMessage({
        target: 'service-worker',
        action: 'OFFSCREEN_HEARTBEAT',
        tabId: tabId
      }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* SW may be torn down between heartbeats; ignore */ }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * playbackPaused: the only flag that tells paused from playing.
 *
 * This document decides the state but cannot store it. Only chrome.runtime is
 * available here, so it reports every transition to the service worker, which
 * owns the write. See the API note at the top of this file.
 *
 * The post is unconditional. It used to be skipped when there was no tab,
 * which was correct while it was only a UI relay, but the message is now the
 * sole route to storage and typed-text and Test Voice reads have no tab. Those
 * are exactly the reads the keyboard shortcut exists to serve. tabId therefore
 * travels as null and the service worker skips only the tab relay.
 *
 * Known gap, inherited rather than introduced: if Chrome reclaims this
 * document while a read is paused, neither this flag nor playbackActive is
 * cleared, because both are event driven and nothing fires. playbackActive
 * already behaves that way; chrome.storage.session clears on browser close.
 */
function setPausedFlag(paused) {
  try {
    chrome.runtime.sendMessage({
      target: 'service-worker',
      action: 'OFFSCREEN_PAUSED_CHANGED',
      tabId: currentTabId,
      paused: !!paused
    }, () => { void chrome.runtime.lastError; });
  } catch (e) { /* SW asleep; the next read rebuilds the control anyway */ }
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function getManager() {
  if (!manager) {
    manager = new KokoroManager();
  }
  return manager;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages without target:'offscreen' are bound for the service worker.
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.action === 'OFFSCREEN_GENERATE_AND_PLAY') {
    startHeartbeat(msg.tabId);
    handleGenerateAndPlay(msg.text, msg.voice, msg.speed, msg.tabId)
      .then(() => {
        stopHeartbeat();
        sendResponse({ success: true });
      })
      .catch(err => {
        stopHeartbeat();
        // AbortError = the manager superseded this generate() with a newer
        // one (or the user explicitly stopped). Either way it's not a real
        // failure; surface as success-aborted so the caller doesn't show
        // a "voice generation failed" toast over what the user just chose.
        if (err && err.name === 'AbortError') {
          sendResponse({ success: true, aborted: true });
          return;
        }
        sendResponse({
          success: false,
          error: err && err.message ? err.message : String(err)
        });
      });
    return true;
  }

  if (msg.action === 'OFFSCREEN_STOP') {
    handleStop();
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_PAUSE') {
    if (manager) {
      manager.pause();
      setPausedFlag(true);
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_RESUME') {
    if (manager) {
      manager.resume();
      setPausedFlag(false);
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_PING') {
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_PREWARM') {
    // Initialize the kokoro worker eagerly so the first OFFSCREEN_GENERATE_AND_PLAY
    // doesn't pay WASM compile + ONNX graph parse + first-execute JIT cost.
    // The worker's _init now also runs a 1-token warmup generate using the
    // forwarded `voice`, which loads that voice's embedding into RAM too,
    // so on the user's first real click, ALL three of those costs are gone.
    // Idempotent: subsequent calls hit mgr.ready and resolve immediately.
    // Failures are reported back but never thrown; pre-warm is best-effort
    // and the right-click flow still works (just slow on first use) if this
    // fails.
    const mgr = getManager();
    (async () => {
      try {
        if (typeof mgr._init === 'function' && !mgr.ready) {
          await mgr._init(msg.voice);
        }
        sendResponse({ success: true, ready: mgr.ready === true });
      } catch (err) {
        sendResponse({
          success: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    })();
    return true;
  }

  return false;
});

async function handleGenerateAndPlay(text, voice, speed, tabId) {
  const myRunId = ++activeRunId;
  const mgr = getManager();
  const audio = await mgr.generate(text, voice, speed);

  // Another run started (or a stop happened) while we were awaiting the
  // first audio chunk. Don't wire highlight relays to this audio; the
  // newer run already owns currentTabId / activeRunId.
  if (myRunId !== activeRunId) return audio;

  // Track the active tab so handleStop can also send OFFSCREEN_ENDED for
  // highlight cleanup (mgr.stop() does NOT fire `ended`/`error`, so without
  // explicit signaling, the page highlight would stay until the watchdog
  // catches it ~60s later).
  currentTabId = tabId || null;

  // Clear the paused flag here, not only in onEnded. A new read supersedes the
  // previous one via ++activeRunId above, which makes the OLD run's onEnded
  // early-return on the myRunId check and swallow its own clear. Without this
  // line, starting a read while the previous one was paused would leave
  // playbackPaused set and the popup would show resume over a playing read.
  setPausedFlag(false);

  if (!audio) return audio;

  // Per-chunk timeupdate is only useful when there's a tab to drive a
  // highlight on. For typed-text / Test Voice reads (no tabId), skip the
  // relay; there's no on-page highlight to feed.
  let onTimeUpdate = null;
  let onSentenceStart = null;
  if (tabId) {
    // Watchdog heartbeat: ChunkedAudio fires 'timeupdate' every 5s while
    // playing. Relay to the SW so the content-script highlight watchdog
    // (60s no-update timeout) gets refreshed during long single-sentence
    // reads where applySentenceStart's noteUpdate alone wouldn't fire
    // often enough. No advancement: chunk-boundary sentencestart events
    // (below) are the sole highlight driver.
    onTimeUpdate = () => {
      try {
        chrome.runtime.sendMessage({
          target: 'service-worker',
          action: 'OFFSCREEN_PROGRESS',
          tabId: tabId
        });
      } catch (e) { /* SW may be torn down; safe to ignore */ }
    };
    audio.addEventListener('timeupdate', onTimeUpdate);

    // Precise per-sentence highlight signal. Fires the instant the audio
    // for a Kokoro chunk starts playing, which is exactly the boundary
    // between sentences in the worker's segmentation. Sole driver of
    // highlight advancement; the timeupdate path above only refreshes
    // the content-script watchdog (no advancement).
    const sendSentenceStart = (meta) => {
      if (myRunId !== activeRunId) return;
      if (!meta || typeof meta.text !== 'string' || meta.text.length === 0) return;
      try {
        chrome.runtime.sendMessage({
          target: 'service-worker',
          action: 'OFFSCREEN_SENTENCE_START',
          tabId: tabId,
          text: meta.text,
          index: meta.index
        });
      } catch (e) { /* ignore */ }
    };
    onSentenceStart = (e) => sendSentenceStart(e && e.detail);
    audio.addEventListener('sentencestart', onSentenceStart);

    // The first chunk's 'sentencestart' was dispatched inside mgr.generate()
    // before this listener attached (manager resolves only after play()
    // resolves; ChunkedAudio dispatches synchronously in _advance). Replay
    // it so the highlight lands on sentence 0 right away.
    if (audio.currentSentenceMeta) {
      sendSentenceStart(audio.currentSentenceMeta);
    }
  }

  // The 'ended' relay must fire regardless of tabId. The SW's
  // OFFSCREEN_ENDED handler clears chrome.storage.session.playbackActive,
  // which is the popup's only signal that an offscreen-owned read has
  // finished. Without this, popup reads of typed text would leave the
  // play button stuck on "Reading..." after the audio actually ended.
  //
  // After firing the relay, dispose the just-finished ChunkedAudio so
  // its AudioContext closes and the per-read decoded AudioBuffers
  // (typically ~1-5 MB) are released for GC. The Kokoro model in the
  // worker is NOT touched; it stays warm in the worker for the next
  // read (per the prewarmOnSelection setting). This is just per-read
  // cleanup of the audio queue's transient state.
  const onEnded = () => {
    if (onTimeUpdate) audio.removeEventListener('timeupdate', onTimeUpdate);
    if (onSentenceStart) audio.removeEventListener('sentencestart', onSentenceStart);
    audio.removeEventListener('ended', onEnded);
    audio.removeEventListener('error', onEnded);
    // If a newer run / stop has superseded us, swallow this event so
    // we don't relay OFFSCREEN_ENDED for the old run and accidentally
    // STOP_HIGHLIGHT on the tab the *new* run just lit up. The newer
    // run's stop() already disposed the prior ChunkedAudio for us.
    if (myRunId !== activeRunId) return;
    try {
      chrome.runtime.sendMessage({
        target: 'service-worker',
        action: 'OFFSCREEN_ENDED',
        tabId: tabId || null
      });
    } catch (e) { /* ignore */ }
    // Covers natural end, decode error, worker fatal (kokoro-manager dispatches
    // 'error' on the audio for those) and the chain-drain deadline, because this
    // handler is bound to both 'ended' and 'error'. Ordered BEFORE currentTabId
    // is cleared so the SET_PAUSE_UI relay still has a tab to address: the page
    // control is also torn down by the STOP_HIGHLIGHT that OFFSCREEN_ENDED
    // triggers, but the relay should not depend on that second mechanism.
    setPausedFlag(false);
    if (currentTabId === tabId) currentTabId = null;

    // Release the per-read audio cache. dispose() is idempotent so a
    // racing handleStop() that also disposes is safe. Pause / Resume
    // / Restart from the popup all handle a disposed ChunkedAudio
    // gracefully (early-return on this._disposed). Nulling out
    // manager.audio prevents stale reference retention.
    try { audio.dispose(); } catch (e) { /* ignore */ }
    if (manager && manager.audio === audio) {
      manager.audio = null;
    }
  };
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', onEnded);

  return audio;
}

function handleStop() {
  // Invalidate any in-flight run's onEnded listener BEFORE we tear down the
  // manager. mgr.stop() disposes the current ChunkedAudio (which closes the
  // AudioContext); any stray 'error' fired during teardown would otherwise
  // round-trip through onEnded → OFFSCREEN_ENDED → STOP_HIGHLIGHT and kill
  // the *next* run's highlight if one starts before this teardown finishes.
  activeRunId++;
  stopHeartbeat();
  if (manager) manager.stop();
  // Every stop surface lands here: the popup's Stop and Restart both forward
  // OFFSCREEN_STOP, as does the on-page button and the keyboard path.
  setPausedFlag(false);

  // Clean up the page highlight. mgr.stop() pauses audio without firing
  // `ended`, so the listener registered in handleGenerateAndPlay won't run.
  // Send OFFSCREEN_ENDED explicitly so the SW can relay STOP_HIGHLIGHT.
  if (currentTabId !== null) {
    try {
      chrome.runtime.sendMessage({
        target: 'service-worker',
        action: 'OFFSCREEN_ENDED',
        tabId: currentTabId
      });
    } catch (e) { /* ignore */ }
    currentTabId = null;
  }
}
