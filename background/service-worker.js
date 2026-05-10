/**
 * GlowReadTTS Service Worker
 * Handles AI-voice context-menu reading (routed through the offscreen
 * document) and highlight relay.
 */

console.log('[GlowReadTTS] Service worker starting...');

// Bumping this constant forces all users to re-accept the EULA on next launch.
const CURRENT_EULA_VERSION = '1.1';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// Default AI voice. Mirrors popup.js's DEFAULT_AI_VOICE.
const DEFAULT_AI_VOICE_ID = 'af_heart';

const state = {
  highlightTabId: null
};

// Playback state chokepoints. Mirrors popup.js's pair. SW-initiated playback
// (right-click context menu) sets/clears the same `playbackActive` flag in
// chrome.storage.session so the popup banner surfaces correctly when reopened
// during a SW-driven read.
async function notifyPlaybackStartedSW(source) {
  try {
    await chrome.storage.session.set({ playbackActive: true });
    console.log('[GlowReadTTS SW] Playback started:', source);
  } catch (e) {
    console.log('[GlowReadTTS SW] Could not set playback state:', e.message);
  }
}

async function notifyPlaybackEndedSW(reason) {
  try {
    await chrome.storage.session.remove('playbackActive');
    console.log('[GlowReadTTS SW] Playback ended:', reason);
  } catch (e) {
    console.log('[GlowReadTTS SW] Could not clear playback state:', e.message);
  }
}

// Per-session flag. Resets on extension reload (the SW is torn down too).
// Tracks whether we've shown the "Preparing audio" notification yet, so the
// first AI right-click of a session shows it and subsequent ones don't.
let offscreenSessionStarted = false;

// In-flight de-dupe for prewarmOffscreenIfAIVoice. Multiple WARM_AI_VOICE
// pings in quick succession (e.g., user keeps adjusting their selection)
// collapse to a single prewarm attempt.
let offscreenPrewarmPromise = null;

/**
 * Eagerly create the offscreen document and warm its kokoro worker so the
 * user's first right-click read pays only inference time, not the full
 * model-load + JIT-warmup + voice-fetch cost (~3-6 s on warm CPUs). Called
 * from the WARM_AI_VOICE message handler when the content script detects
 * a meaningful text selection AND the user hasn't disabled the
 * `prewarmOnSelection` setting.
 *
 * Best-effort: any failure is logged and swallowed — the on-demand path in
 * speakFromServiceWorker still creates the offscreen doc as a fallback.
 */
async function prewarmOffscreenIfAIVoice() {
  if (offscreenPrewarmPromise) return offscreenPrewarmPromise;
  offscreenPrewarmPromise = (async () => {
    try {
      const stored = await chrome.storage.sync.get(['voice', 'settings']);
      const voice = stored.voice || (stored.settings && stored.settings.voice) || '';
      if (typeof voice !== 'string' || !voice.startsWith('ai:')) return;
      // Strip the "ai:" prefix — the worker's warmup generate expects a
      // raw kokoro voice id (e.g. "af_heart"). Forwarding it means the
      // warmup loads that voice's embedding too, so the first real read
      // pays no per-voice fetch cost.
      const aiVoice = voice.replace(/^ai:/, '');

      await ensureOffscreenDocument();
      await waitForOffscreenReady();
      const reply = await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'OFFSCREEN_PREWARM',
        voice: aiVoice
      });
      if (reply && reply.success === false) {
        console.warn('[GlowReadTTS SW] Offscreen prewarm reported failure:', reply.error);
      }
    } catch (err) {
      console.warn('[GlowReadTTS SW] Offscreen prewarm failed (will retry on demand):', err && err.message);
    } finally {
      offscreenPrewarmPromise = null;
    }
  })();
  return offscreenPrewarmPromise;
}

async function hasOffscreenDocument() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    return await chrome.offscreen.hasDocument();
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    // The doc exists, but if its scripts are still loading on a fresh
    // page-load this returns true while the listener isn't registered yet.
    // waitForOffscreenReady handles that race.
    return;
  }
  // Clear any stale readiness flag from a previous offscreen session before
  // creating the new doc, so waitForOffscreenReady waits for THIS load.
  try { await chrome.storage.session.remove('offscreenReady'); } catch (e) { /* ignore */ }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    // AUDIO_PLAYBACK alone is not enough: Chrome only treats it as an active
    // reason while audio is actually playing. The bundled neural model takes
    // 5–30 s to compile + load before any audio exists, and during that window
    // the offscreen document is considered idle and gets torn down — which
    // kills the inference Worker mid-init and causes the SW->offscreen
    // sendMessage to reject with "channel closed before a response was
    // received". WORKERS keeps the document alive whenever the offscreen has
    // an active Web Worker (which we always do once kokoro-manager spawns one).
    reasons: ['WORKERS', 'AUDIO_PLAYBACK'],
    justification: 'Run on-device neural TTS inference in a Web Worker and play the resulting audio in response to user-initiated right-click reading.'
  });
}

// Wait until offscreen.js has registered its message listener. Two paths:
//   1. Fast path: storage flag set on offscreen module load.
//   2. Slow path: ping the offscreen and wait for any reply.
// Bounded so a broken offscreen doc surfaces as a real error instead of
// hanging the right-click flow forever.
const OFFSCREEN_READY_TIMEOUT_MS = 10_000;
async function waitForOffscreenReady() {
  const start = Date.now();
  while (Date.now() - start < OFFSCREEN_READY_TIMEOUT_MS) {
    try {
      const { offscreenReady } = await chrome.storage.session.get('offscreenReady');
      if (offscreenReady) return;
    } catch (e) { /* fall through to ping */ }
    try {
      const reply = await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'OFFSCREEN_PING'
      });
      if (reply && reply.success) return;
    } catch (e) { /* listener not yet registered; retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Offscreen document failed to become ready within ' + OFFSCREEN_READY_TIMEOUT_MS + 'ms');
}

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icon-128.png'),
      title: title,
      message: message,
      priority: 0
    });
  } catch (e) {
    // Notifications are best-effort; never let a notification failure
    // break the underlying speech flow.
  }
}

function openEulaTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('eula/eula.html') });
}

async function isEulaAccepted() {
  const result = await chrome.storage.local.get(['eula_accepted', 'eula_version']);
  return Boolean(result.eula_accepted) && result.eula_version === CURRENT_EULA_VERSION;
}

/**
 * Send a message to a tab's content script (best-effort, silent on failure).
 * Reads chrome.runtime.lastError to suppress "Receiving end does not exist"
 * errors on restricted pages (chrome://, new tab, etc.)
 */
function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message, function() {
    if (chrome.runtime.lastError) { /* intentionally empty */ }
  });
}

/**
 * Ensure the persistent content script is loaded on the given tab. Required
 * for highlight messages to actually do something — without it, sendToTab
 * silently succeeds (lastError gets eaten in sendToTab's callback) and no
 * highlight ever appears. Tabs opened BEFORE the extension was installed or
 * reloaded don't have the content script from the manifest's content_scripts
 * entry, so we inject the same files + CSS on demand.
 *
 * Idempotent via a probe: send a benign message first; if a response comes
 * back, the script is already loaded and we skip injection. Injection
 * failures (restricted pages, etc.) are non-fatal — caller proceeds; speech
 * still plays, just without on-page highlighting.
 */
async function ensureContentScript(tab) {
  if (!tab || !tab.id || !tab.url) return false;
  if (tab.url.startsWith('chrome://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('about:')) {
    return false;
  }
  try {
    // Bound the probe — if a stale listener from an older version returned
    // `true` without calling sendResponse, the message channel could hang.
    // 500 ms is comfortably above the round-trip for an in-page listener.
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { action: 'PING' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 500))
    ]);
    if (reply !== undefined) return true;
  } catch (e) {
    // "Receiving end does not exist" or ping timeout — proceed to inject.
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content/content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js']
    });
    return true;
  } catch (e) {
    console.warn('[GlowReadTTS SW] Could not inject content script:', e && e.message);
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[GlowReadTTS] Extension installed:', details);

  offscreenSessionStarted = false;

  if (details.reason === 'install') {
    openEulaTab();
  }

  if (details.reason === 'update') {
    const result = await chrome.storage.local.get(['eula_version']);
    if (result.eula_version !== CURRENT_EULA_VERSION) {
      openEulaTab();
    }
  }

  const defaults = {
    voice: 'ai:' + DEFAULT_AI_VOICE_ID,
    speed: 1.0
  };

  const existingSync = await chrome.storage.sync.get('settings');
  if (!existingSync.settings) {
    await chrome.storage.sync.set({ settings: defaults });
  }
  // Default selection-prewarm to ON. New installs and existing users
  // who never set the value get fast first-reads (~1-2 s) at the cost
  // of ~95 MB of RAM after their first text selection of a session.
  // Power users on low-RAM devices can opt out from the options page.
  //
  // Stored in chrome.storage.local (NOT sync) — this is a per-device
  // performance preference. A user might legitimately want it ON on a
  // 16 GB desktop and OFF on a 4 GB Chromebook, and it doesn't make
  // sense to sync that decision to Google.
  const existingLocal = await chrome.storage.local.get('prewarmOnSelection');
  if (typeof existingLocal.prewarmOnSelection !== 'boolean') {
    await chrome.storage.local.set({ prewarmOnSelection: true });
  }

  chrome.contextMenus.create({
    id: 'glowreadtts-read',
    title: 'Read with GlowReadTTS',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'glowreadtts-read' || !info.selectionText) return;

  if (!(await isEulaAccepted())) {
    openEulaTab();
    return;
  }

  // Inject the content script if the tab doesn't already have it. Required
  // for highlight-as-you-read on tabs opened before the extension was
  // installed/reloaded. Best-effort; speech still plays if injection fails.
  await ensureContentScript(tab);

  // Prefer visibility-filtered selection text from the content script over
  // Chrome's info.selectionText. Chrome's value includes hidden screen-
  // reader-only / off-screen / clipped DOM nodes, which then get read
  // aloud verbatim and make the audio sound like it's starting in the
  // wrong place. The content script's TreeWalker drops those.
  // 200 ms timeout covers the round-trip; if anything goes wrong (no
  // content script on a restricted page, slow tab, empty visible text)
  // we fall back to info.selectionText so the read still happens.
  let textToRead = info.selectionText;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { action: 'GET_VISIBLE_SELECTION' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 200))
    ]);
    if (reply && typeof reply.text === 'string' && reply.text.trim().length > 0) {
      textToRead = reply.text;
    }
  } catch (e) { /* fallback to info.selectionText */ }

  await speakFromServiceWorker(textToRead, tab.id);
});

/**
 * Speak text directly from the service worker (context-menu flow).
 * Loads saved voice/speed and routes to the offscreen document for
 * on-device AI inference. Drives sentence highlighting on the page.
 * Independent of the popup. AI-only since browser TTS was removed.
 */
async function speakFromServiceWorker(text, tabId) {
  if (!text || !tabId) return;

  if (state.highlightTabId) {
    sendToTab(state.highlightTabId, { action: 'STOP_HIGHLIGHT' });
  }

  const settings = await chrome.storage.sync.get(['voice', 'speed']);
  // Fall back to the default if the stored voice isn't a recognized AI id.
  let storedVoice = settings.voice || '';
  if (typeof storedVoice !== 'string' || !storedVoice.startsWith('ai:')) {
    storedVoice = 'ai:' + DEFAULT_AI_VOICE_ID;
  }
  const aiVoice = storedVoice.replace(/^ai:/, '');
  // Clamp speed to slider range (0.25–2.0) — the right-click flow reads
  // storage independently and could otherwise pick up a stale out-of-range
  // value the popup never had a chance to migrate.
  const rawSpeed = parseFloat(settings.speed) || 1.0;
  const speed = Math.max(0.25, Math.min(2.0, rawSpeed));

  try {
    if (!offscreenSessionStarted) {
      showNotification('Preparing audio', 'Loading AI voice for first use this session...');
      offscreenSessionStarted = true;
    }

    await ensureOffscreenDocument();
    await waitForOffscreenReady();

    // Tell the page to start highlighting before we kick off generation.
    // This way the highlight is ready when audio starts playing.
    state.highlightTabId = tabId;
    sendToTab(tabId, {
      action: 'START_HIGHLIGHT',
      text: text
    });

    notifyPlaybackStartedSW('right-click-ai-voice');

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_GENERATE_AND_PLAY',
      text: text,
      voice: aiVoice,
      speed: speed,
      tabId: tabId
    });

    if (!response || !response.success) {
      throw new Error((response && response.error) || 'Offscreen generation returned no response');
    }
    // Successful AI playback. Highlight advancement is driven by
    // OFFSCREEN_SENTENCE_START messages relayed from the offscreen
    // document; OFFSCREEN_PROGRESS only refreshes the content-script
    // watchdog. Cleanup happens via OFFSCREEN_ENDED when audio finishes
    // or is stopped.
  } catch (err) {
    console.error('[GlowReadTTS] AI voice playback failed:', err);
    showNotification(
      'Voice generation failed',
      'Could not generate audio for that selection. Try again, or open the extension to check status.'
    );
    if (state.highlightTabId === tabId) {
      sendToTab(tabId, { action: 'STOP_HIGHLIGHT' });
      state.highlightTabId = null;
    }
    notifyPlaybackEndedSW('right-click-ai-error');
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Skip messages explicitly targeted at the offscreen document; they're
  // handled by offscreen.js. Without this filter, the SW would respond
  // "Unknown action" and pollute the console with each offscreen message.
  if (request && request.target && request.target !== 'service-worker') {
    return false;
  }

  console.log('[Service Worker] Message received:', request.action);

  (async () => {
    try {
      switch (request.action) {
        case 'OFFSCREEN_PROGRESS':
          // Watchdog tap from the offscreen (every ~5s while audio plays).
          // Relayed as HIGHLIGHT_PROGRESS so the content-script watchdog
          // refreshes lastUpdateAt and doesn't trip the 60s no-update
          // cleanup mid-read. Highlight advancement is driven by
          // OFFSCREEN_SENTENCE_START, NOT this message.
          if (request.tabId) {
            sendToTab(request.tabId, { action: 'HIGHLIGHT_PROGRESS' });
          }
          sendResponse({ success: true });
          break;

        case 'OFFSCREEN_SENTENCE_START':
          // Precise per-chunk highlight signal: the offscreen has just
          // started playing the audio for one Kokoro sentence. Forward to
          // the page so the highlight lands exactly on the matching page
          // sentence instead of relying on currentTime/duration math.
          if (request.tabId) {
            sendToTab(request.tabId, {
              action: 'SENTENCE_START',
              text: request.text,
              index: request.index
            });
          }
          sendResponse({ success: true });
          break;

        case 'OFFSCREEN_ENDED':
          // AI audio finished, errored, or was stopped. Clean up highlight on the page.
          if (request.tabId) {
            sendToTab(request.tabId, { action: 'STOP_HIGHLIGHT' });
          }
          if (state.highlightTabId === request.tabId) {
            state.highlightTabId = null;
          }
          notifyPlaybackEndedSW('offscreen-natural-end');
          sendResponse({ success: true });
          break;

        case 'OFFSCREEN_HEARTBEAT':
          // Offscreen heartbeat during a slow generation. Receiving and
          // replying to this message resets the SW's idle timer, preventing
          // termination mid-await on the OFFSCREEN_GENERATE_AND_PLAY response.
          sendResponse({ success: true });
          break;

        case 'WARM_AI_VOICE':
          // Selection-driven prewarm signal from the content script.
          // Content script gates on the user's `prewarmOnSelection`
          // setting before sending this — if it arrives, the user has
          // opted into faster first-reads at the cost of ~95 MB of RAM
          // after their first selection of the session. The prewarm
          // call itself is idempotent so repeated pings collapse.
          prewarmOffscreenIfAIVoice();
          sendResponse({ success: true });
          break;

        case 'STOP_FROM_PAGE':
          // The on-page Stop button (rendered by the content script during
          // a right-click read) was clicked. Forward OFFSCREEN_STOP to the
          // offscreen so it tears down the audio queue and posts back
          // OFFSCREEN_ENDED — which then relays STOP_HIGHLIGHT to the tab,
          // hiding the page button and clearing the highlight in one go.
          // Same code path as the popup's Stop button, just from the page.
          try {
            chrome.runtime.sendMessage(
              { target: 'offscreen', action: 'OFFSCREEN_STOP' },
              () => { void chrome.runtime.lastError; }
            );
          } catch (e) { /* offscreen unavailable; safe to ignore */ }
          sendResponse({ success: true });
          break;

        case 'POPUP_AI_GENERATE': {
          // Popup-driven AI read. Routes through the offscreen document so
          // the warm kokoro worker is reused across popup-close / reopen
          // cycles (the popup context dies on close; the offscreen survives
          // for the browser session). Mirrors the right-click flow's
          // ensureOffscreen + forward pattern.
          try {
            await ensureOffscreenDocument();
            await waitForOffscreenReady();

            // If the popup signals that this read is for on-page text,
            // drive the highlight on the active tab the same way
            // speakFromServiceWorker does for right-click reads. (Currently
            // no popup path sets tabId — typed text / Test Voice both pass
            // tabId=null — but the relay is kept for any future on-page
            // entry point added to the popup.)
            if (request.tabId && request.text) {
              state.highlightTabId = request.tabId;
              sendToTab(request.tabId, {
                action: 'START_HIGHLIGHT',
                text: request.text
              });
            }

            notifyPlaybackStartedSW('popup-ai-voice');

            const reply = await chrome.runtime.sendMessage({
              target: 'offscreen',
              action: 'OFFSCREEN_GENERATE_AND_PLAY',
              text: request.text,
              voice: request.voice,
              speed: request.speed,
              tabId: request.tabId || null
            });

            if (!reply || !reply.success) {
              throw new Error((reply && reply.error) || 'Offscreen generation returned no response');
            }
            // Forward `aborted` so the popup can distinguish supersession
            // (don't show error toast, don't update UI to "Reading...") from
            // a real successful start.
            sendResponse({ success: true, aborted: reply.aborted === true });
          } catch (err) {
            console.error('[GlowReadTTS SW] POPUP_AI_GENERATE failed:', err);
            // Clear highlight + playback flag so the popup UI doesn't
            // get stuck in "Reading..." state on a failed start.
            if (state.highlightTabId) {
              sendToTab(state.highlightTabId, { action: 'STOP_HIGHLIGHT' });
              state.highlightTabId = null;
            }
            notifyPlaybackEndedSW('popup-ai-error');
            sendResponse({
              success: false,
              error: err && err.message ? err.message : String(err)
            });
          }
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Error:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

console.log('[GlowReadTTS] Service worker ready');
