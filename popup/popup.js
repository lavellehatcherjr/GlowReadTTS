/**
 * GlowReadTTS Popup - Complete Version with Working Selection
 */

console.log('[GlowReadTTS] Popup script starting...');

// Default voice when storage is empty or holds a stale browser-TTS voice.
// Mirrors background/service-worker.js's default for the right-click path.
const DEFAULT_AI_VOICE = 'ai:af_heart';

// Global state
const state = {
  isPlaying: false,
  isPaused: false,
  currentVoice: DEFAULT_AI_VOICE,
  currentSpeed: 1.0,
  currentText: '',
  shouldHighlight: false  // true when reading page/selection text (enables highlight-as-you-read)
};

// Playback state chokepoints. ALL audio start events route through notifyPlaybackStarted.
// ALL audio termination events (user-stop, natural-end, error) route through notifyPlaybackEnded.
// State persists across popup close/open via chrome.storage.session, used to surface
// the "Reading in progress" banner when the popup reopens during active playback.
async function notifyPlaybackStarted(source) {
  try {
    await chrome.storage.session.set({ playbackActive: true });
    console.log('[GlowReadTTS] Playback started:', source);
  } catch (e) {
    console.log('[GlowReadTTS] Could not set playback state:', e.message);
  }
}

async function notifyPlaybackEnded(reason) {
  try {
    await chrome.storage.session.remove('playbackActive');
    console.log('[GlowReadTTS] Playback ended:', reason);
  } catch (e) {
    console.log('[GlowReadTTS] Could not clear playback state:', e.message);
  }
}

// Subscribe to chrome.storage.session changes so the popup learns when an
// offscreen-owned AI read (the popup's typed-text reads, page reads,
// selection reads, AND right-click reads all live in the offscreen) finishes
// or is stopped. The SW clears `playbackActive` on OFFSCREEN_ENDED, which
// fires both on natural stream-end AND on user-stop. Without this listener
// the popup's button + status would stay frozen on "Reading..." until the
// user re-clicks something.
function setupPlaybackStateSync() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      if (!changes.playbackActive) return;
      const isActive = changes.playbackActive.newValue === true;
      if (isActive) return; // start events update the UI directly elsewhere
      // playbackActive was cleared. Mirror the natural-end UI cleanup that
      // the popup-owned browser-TTS path already runs from its onEvent
      // 'end' handler. Idempotent: state mutators are safe to repeat.
      handleRemotePlaybackEnded();
    });
  } catch (e) {
    // chrome.storage.onChanged may be unavailable (very old Chrome).
    // Without it the popup UI would just lag a bit when an offscreen read
    // ends; the next button click resets state.
  }
}

function handleRemotePlaybackEnded() {
  // Banner reflects "is something reading right now"; hide it.
  const banner = document.getElementById('stop-reading-banner');
  if (banner) banner.classList.remove('visible');

  if (!state.isPlaying) return;

  state.isPlaying = false;
  state.isPaused = false;
  updatePlayButton('stopped');
  updateStatus('Finished');
  if (state.shouldHighlight) {
    sendHighlightMessage('STOP_HIGHLIGHT');
    state.shouldHighlight = false;
  }
  setTimeout(() => hidePlaybackControls(), 2000);
}

// Send a fire-and-forget action to the offscreen document (used for stop /
// pause / resume of right-click AI reads that the popup doesn't directly own).
// If the offscreen doc doesn't exist yet, chrome.runtime.lastError is set
// inside the callback and we ignore it.
function forwardOffscreenAction(action) {
  try {
    chrome.runtime.sendMessage({ target: 'offscreen', action }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) { /* offscreen unavailable; safe to ignore */ }
}

// Lazily-loaded voice catalog (single source of truth for shipped Kokoro voices).
let voiceCatalog = null;
async function getVoiceCatalog() {
  if (!voiceCatalog) {
    voiceCatalog = await import(chrome.runtime.getURL('libs/kokoro/voices-catalog.js'));
  }
  return voiceCatalog;
}

// Inline Lucide SVG icons (MIT) - keeps UI consistent across OS emoji renderers.
// Only static literals defined here; safe to assign via innerHTML.
const icons = {
  volume: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  textCursor: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1M7 22h1a4 4 0 0 1 4-4V6a4 4 0 0 1-4-4H7M12 2v20"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
  help: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>',
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  stop: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  restart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
  mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>',
  settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'
};

// Wrap everything in try-catch to see errors
try {
  // Initialize when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePopup);
  } else {
    // DOM already loaded
    initializePopup();
  }
} catch (error) {
  console.error('[GlowReadTTS] Fatal error:', error);
  renderFallbackMessage(document.body, 'Error loading extension. Please check console.');
}

// Bumping this constant forces all users to re-accept the EULA on next launch.
const CURRENT_EULA_VERSION = '1.1';

async function initializePopup() {
  try {
    console.log('[GlowReadTTS] Initializing popup...');

    const eulaStatus = await chrome.storage.local.get(['eula_accepted', 'eula_version']);
    if (!eulaStatus.eula_accepted || eulaStatus.eula_version !== CURRENT_EULA_VERSION) {
      renderEulaGate();
      return;
    }

    // First check if container exists
    const container = document.getElementById('popup-container');
    if (!container) {
      console.error('[GlowReadTTS] Container not found!');
      renderFallbackMessage(document.body, 'Container not found');
      return;
    }

    await createUI();
    await createStopReadingBanner();
    setupEventListeners();
    setupPlaybackStateSync();
    await loadSavedSettings();

    // No prewarm here. The extension is fully on-demand — the AI voice
    // model loads only when the user explicitly invokes a read (Read
    // Text / Test Voice / right-click), trading a 3–6 s cold-load on
    // the first read of a session for ~95 MB less idle RAM.

    console.log('[GlowReadTTS] Initialization complete');
  } catch (error) {
    console.error('[GlowReadTTS] Initialization error:', error);
    showError(error);
  }
}

// Surfaces a "Reading in progress" banner when the popup reopens during an
// active read. State comes from chrome.storage.session.playbackActive, which
// is set/cleared by notifyPlaybackStarted/notifyPlaybackEnded chokepoints.
// Must run AFTER createUI() because createUI() rewrites container.innerHTML.
async function createStopReadingBanner() {
  const container = document.getElementById('popup-container');
  if (!container) return;

  const banner = document.createElement('div');
  banner.id = 'stop-reading-banner';
  banner.className = 'stop-reading-banner';
  banner.innerHTML = `
    <div class="banner-content">
      <span class="banner-icon">⏸</span>
      <span class="banner-text">Reading in progress</span>
      <button id="banner-stop-btn" class="banner-stop-btn">Stop</button>
    </div>
  `;

  // Click anywhere on the banner triggers stop. handleStop already calls
  // notifyPlaybackEnded('user-stop'), which clears the flag.
  banner.addEventListener('click', () => {
    handleStop();
    banner.classList.remove('visible');
  });

  container.insertBefore(banner, container.firstChild);

  try {
    const result = await chrome.storage.session.get('playbackActive');
    if (result.playbackActive) {
      banner.classList.add('visible');
      // Reflect the cross-context read in popup state so the play/pause
      // button is reachable. Without this, the user could only Stop a
      // right-click read from the popup. handlePlayPause forwards
      // OFFSCREEN_PAUSE / OFFSCREEN_RESUME, which works regardless of
      // which context started the read.
      state.isPlaying = true;
      state.isPaused = false;
      updatePlayButton('playing');
      showPlaybackControls();
    }
  } catch (e) {
    // chrome.storage.session unavailable; banner stays hidden.
  }
}

// Render the "Terms Not Accepted" screen inside the popup. No extension
// functionality runs until the user opens the EULA tab and accepts.
function renderEulaGate() {
  const container = document.getElementById('popup-container');
  if (!container) return;

  container.textContent = '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding: 20px; text-align: center; color: #1A1815; background: #FAFAF7; font-family: Georgia, "Times New Roman", serif;';

  const heading = document.createElement('h3');
  heading.textContent = 'Terms Not Accepted';
  heading.style.cssText = 'margin-bottom: 12px; font-size: 16px; font-family: Georgia, "Times New Roman", serif;';

  const msg = document.createElement('p');
  msg.textContent = 'You must accept the Terms of Use and Privacy Policy to use GlowReadTTS.';
  msg.style.cssText = 'color: #6B6864; font-size: 13px; margin-bottom: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';

  const btn = document.createElement('button');
  btn.textContent = 'Review Terms';
  btn.style.cssText = 'padding: 10px 20px; background: #2A8B8B; color: #1A1815; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;';
  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('eula/eula.html') });
    window.close();
  });

  wrapper.append(heading, msg, btn);
  container.append(wrapper);
}

// Render a single-line fallback message using safe DOM APIs.
function renderFallbackMessage(target, message) {
  if (!target) return;
  target.textContent = '';
  const div = document.createElement('div');
  div.style.cssText = 'padding: 20px; color: #1A1815; background: #FAFAF7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';
  div.textContent = message;
  target.append(div);
}

function showError(error) {
  const container = document.getElementById('popup-container') || document.body;
  container.textContent = ''; // Clear safely

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding: 20px; color: #1A1815; background: #FAFAF7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';

  const heading = document.createElement('h3');
  heading.style.cssText = 'color: #EF4444; font-family: Georgia, "Times New Roman", serif;';
  heading.textContent = 'Error Loading GlowReadTTS';

  const msg = document.createElement('p');
  msg.style.cssText = 'color: #6B6864; font-size: 12px; margin-top: 8px;';
  msg.textContent = error.message;

  const btn = document.createElement('button');
  btn.style.cssText = 'margin-top: 10px; padding: 8px 16px; background: #2A8B8B; color: #1A1815; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());

  wrapper.append(heading, msg, btn);
  container.append(wrapper);
}

async function createUI() {
  console.log('[GlowReadTTS] Creating UI...');

  const container = document.getElementById('popup-container');
  if (!container) {
    throw new Error('Container element not found');
  }

  // Build the AI voice optgroups from the catalog. Two groups: American and
  // British, each ordered by Kokoro grade descending (catalog order is preserved).
  const { voicesByLanguage } = await getVoiceCatalog();
  const buildAIOptgroup = (langCode, id, label) => {
    const options = voicesByLanguage(langCode)
      .map(v => `<option value="ai:${v.id}">${v.displayName} - ${v.tagline}</option>`)
      .join('\n              ');
    return `<optgroup id="${id}" label="${label}">
              ${options}
            </optgroup>`;
  };
  const aiVoicesOptgroups =
    buildAIOptgroup('a', 'ai-voices-american', '🇺🇸 American English') +
    '\n            ' +
    buildAIOptgroup('b', 'ai-voices-british', '🇬🇧 British English');

  // Build UI from a static template that interpolates only the icons object
  // (static SVG literals defined above; no user input) and the catalog-derived
  // optgroup markup.
  container.innerHTML = `
    <div class="container">
      <!-- Header -->
      <div class="header">
        <h1>${icons.volume} GlowReadTTS</h1>
        <p>On-Device AI Voices. Highlight as You Read.</p>
      </div>

      <!-- Text Input Area -->
      <div class="text-input-section">
        <div class="section-header">
          <label class="section-label">${icons.textCursor} Paste or Type Text</label>
          <div class="text-controls">
            <button id="btn-clear-text" class="text-btn" title="Clear text">${icons.trash}</button>
            <button id="btn-help" class="text-btn" title="Help &amp; Getting Started" aria-label="Help">${icons.help}</button>
          </div>
        </div>
        <textarea
          id="text-input"
          class="text-input"
          placeholder="Paste or type text here to read it aloud..."
          rows="4"
        ></textarea>
        <div class="text-actions">
          <button id="btn-read-text" class="action-btn-primary">
            <span>${icons.play} Read Text</span>
          </button>
          <span id="char-count" class="char-count">0 characters</span>
        </div>
      </div>

      <!-- Playback Controls (shown when playing) -->
      <div id="playback-section" class="playback-section">
        <div class="playback-controls">
          <button id="btn-stop" class="control-btn" title="Stop">${icons.stop}</button>
          <button id="btn-play-pause" class="control-btn primary" title="Play/Pause">${icons.pause}</button>
          <button id="btn-restart" class="control-btn" title="Restart">${icons.restart}</button>
        </div>
        <div id="status-text" class="status-text">Ready</div>
      </div>

      <!-- Quick Actions -->
      <div class="actions-section">
        <label class="section-label">Quick Actions</label>
        <div class="actions-grid">
          <button id="btn-help-action" class="action-btn" title="Open the Getting Started help guide">
            <span class="action-icon">${icons.help}</span>
            <span>Help</span>
          </button>
          <button id="btn-test" class="action-btn" title="Test current voice">
            <span class="action-icon">${icons.mic}</span>
            <span>Test Voice</span>
          </button>
          <button id="btn-settings" class="action-btn" title="Open settings">
            <span class="action-icon">${icons.settings}</span>
            <span>Settings</span>
          </button>
        </div>
      </div>

      <!-- Voice & Speed Settings -->
      <div class="settings-section">
        <!-- Voice Selection -->
        <div class="setting-group">
          <label class="setting-label">Voice</label>
          <select id="voice-select" class="select-input">
            ${aiVoicesOptgroups}
          </select>
        </div>

        <!-- Speed Control -->
        <div class="setting-group">
          <label class="setting-label">Speed</label>
          <div class="speed-control">
            <input type="range" id="speed-slider" class="speed-slider"
                   min="0.25" max="2" step="0.25" value="1">
            <span id="speed-value" class="speed-value">1.0x</span>
          </div>
        </div>
      </div>
    </div>
  `;
  
  console.log('[GlowReadTTS] UI created successfully');
}

function setupEventListeners() {
  try {
    console.log('[GlowReadTTS] Setting up event listeners...');
    
    // Text input controls
    const textInput = document.getElementById('text-input');
    if (textInput) {
      textInput.addEventListener('input', handleTextInput);
    }
    
    const readBtn = document.getElementById('btn-read-text');
    if (readBtn) {
      readBtn.addEventListener('click', handleReadText);
    }
    
    const clearBtn = document.getElementById('btn-clear-text');
    if (clearBtn) {
      clearBtn.addEventListener('click', handleClearText);
    }
    
    const helpBtn = document.getElementById('btn-help');
    if (helpBtn) {
      helpBtn.addEventListener('click', handleHelpClick);
    }
    
    // Playback controls
    const playPauseBtn = document.getElementById('btn-play-pause');
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', handlePlayPause);
    }
    
    const stopBtn = document.getElementById('btn-stop');
    if (stopBtn) {
      stopBtn.addEventListener('click', handleStop);
    }
    
    const restartBtn = document.getElementById('btn-restart');
    if (restartBtn) {
      restartBtn.addEventListener('click', handleRestart);
    }
    
    // Action buttons
    const helpActionBtn = document.getElementById('btn-help-action');
    if (helpActionBtn) {
      // Reuses handleHelpClick — same target as the smaller question-mark
      // icon next to the textarea, just exposed as a Quick Action for
      // discoverability.
      helpActionBtn.addEventListener('click', handleHelpClick);
    }

    const testBtn = document.getElementById('btn-test');
    if (testBtn) {
      testBtn.addEventListener('click', handleTestVoice);
    }

    const settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', handleSettings);
    }
    
    // Voice and speed
    const voiceSelect = document.getElementById('voice-select');
    if (voiceSelect) {
      voiceSelect.addEventListener('change', handleVoiceChange);
    }
    
    const speedSlider = document.getElementById('speed-slider');
    if (speedSlider) {
      speedSlider.addEventListener('input', handleSpeedChange);
    }

    console.log('[GlowReadTTS] Event listeners setup complete');
  } catch (error) {
    console.error('[GlowReadTTS] Error setting up event listeners:', error);
  }
}

// Text Input Handlers
function handleTextInput(e) {
  const text = e.target.value;
  state.currentText = text;

  const charCount = document.getElementById('char-count');
  if (charCount) {
    charCount.textContent = `${text.length} characters`;

    charCount.classList.remove('warning', 'error');
    if (text.length > 5000) {
      charCount.classList.add('error');
      charCount.title = 'Long texts (over 5,000 characters) may be cut off by the speech engine. Consider splitting into smaller chunks.';
    } else if (text.length > 2000) {
      charCount.classList.add('warning');
      charCount.title = 'Approaching length limits. Speech may take a moment to start.';
    } else {
      charCount.title = 'Within recommended length range.';
    }
  }

  const readBtn = document.getElementById('btn-read-text');
  if (readBtn) {
    readBtn.disabled = text.trim().length === 0;
  }

  sessionStorage.setItem('glowreadtts-text', text);
}

function handleReadText() {
  const text = document.getElementById('text-input')?.value?.trim();

  if (!text) {
    updateStatus('Please enter some text to read');
    return;
  }

  state.currentText = text;
  state.shouldHighlight = false;  // Typed text isn't on the page
  speakText(text);
}

function handleClearText() {
  const textInput = document.getElementById('text-input');
  if (textInput) {
    textInput.value = '';
    state.currentText = '';
    handleTextInput({ target: textInput });
  }
  
  if (state.isPlaying) {
    handleStop();
  }
}

function handleHelpClick() {
  const helpUrl = chrome.runtime.getURL('help/getting-started.html');
  chrome.tabs.create({ url: helpUrl });
  window.close();
}

// Playback Control Handlers. AI audio always lives in the offscreen
// document (popup-driven and right-click reads alike), so pause / resume /
// stop are single forwarded messages.
function handlePlayPause() {
  if (state.isPlaying && !state.isPaused) {
    forwardOffscreenAction('OFFSCREEN_PAUSE');
    state.isPaused = true;
    updatePlayButton('paused');
    updateStatus('Paused');
  } else if (state.isPaused) {
    forwardOffscreenAction('OFFSCREEN_RESUME');
    state.isPaused = false;
    updatePlayButton('playing');
    updateStatus('Resuming...');
  } else {
    const text = state.currentText || sessionStorage.getItem('lastText');
    if (text) {
      speakText(text);
    } else {
      updateStatus('No text to read');
    }
  }
}

function handleStop() {
  // AI audio (popup-driven OR right-click) lives in the offscreen document.
  // OFFSCREEN_STOP tells it to stop the audio queue, post ABORT to its
  // kokoro worker, and send OFFSCREEN_ENDED back to the SW — which relays
  // STOP_HIGHLIGHT to the active tab. The offscreen keeps its model warm
  // across reads; we deliberately do NOT dispose it here (disposing would
  // force a 3–8 s reload on the next click).
  forwardOffscreenAction('OFFSCREEN_STOP');

  if (state.shouldHighlight) {
    sendHighlightMessage('STOP_HIGHLIGHT');
    state.shouldHighlight = false;
  }

  state.isPlaying = false;
  state.isPaused = false;
  updatePlayButton('stopped');
  hidePlaybackControls();
  updateStatus('Stopped');
  notifyPlaybackEnded('user-stop');
}

function handleRestart() {
  const text = state.currentText || sessionStorage.getItem('lastText');
  if (text) {
    // Stop any in-flight AI read in the offscreen. Mirrors handleStop.
    // Without this, the in-flight offscreen audio would keep playing in
    // parallel with the new restart.
    forwardOffscreenAction('OFFSCREEN_STOP');

    if (state.shouldHighlight) {
      sendHighlightMessage('STOP_HIGHLIGHT');
    }

    // Clear playback flag BEFORE the new read kicks off; speakText will
    // re-set it via notifyPlaybackStarted. Reversing this order would race.
    notifyPlaybackEnded('user-restart');

    setTimeout(() => {
      speakText(text);
    }, 100);
  }
}

// Action Button Handlers
function handleTestVoice() {
  setSelectedButton('btn-test');
  state.shouldHighlight = false;  // Test text isn't on the page

  const testText = "Hello! This is a test of the GlowReadTTS text-to-speech system. " +
                   "You're currently listening to an AI voice at " +
                   state.currentSpeed + "x speed.";
  speakText(testText);
}

function handleSettings() {
  chrome.runtime.openOptionsPage();
}

// Voice and Speed Handlers
async function handleVoiceChange(e) {
  state.currentVoice = e.target.value;
  // Dual-write to flat `voice` and nested `settings.voice` so the popup,
  // options page, and service-worker context-menu flow all see the same value.
  await chrome.storage.sync.set({ voice: state.currentVoice });
  const stored = await chrome.storage.sync.get('settings');
  const settings = stored.settings || {};
  await chrome.storage.sync.set({ settings: { ...settings, voice: state.currentVoice } });

  if (state.isPlaying) {
    handleStop();
  }
  // No prewarm on voice change — the extension loads the model on demand
  // only when an actual read is triggered.
}

async function handleSpeedChange(e) {
  state.currentSpeed = parseFloat(e.target.value);
  document.getElementById('speed-value').textContent = `${state.currentSpeed}x`;
  // Dual-write to flat `speed` and nested `settings.speed` so the popup,
  // options page, and service-worker context-menu flow all see the same value.
  await chrome.storage.sync.set({ speed: state.currentSpeed });
  const stored = await chrome.storage.sync.get('settings');
  const settings = stored.settings || {};
  await chrome.storage.sync.set({ settings: { ...settings, speed: state.currentSpeed } });

  if (state.isPlaying) {
    handleStop();
  }
}

// Main TTS Function. AI-only — every voice in the catalog is an `ai:*` id,
// played in the offscreen document. Supersession of an in-flight read is
// handled by KokoroManager.generate() inside the offscreen, so we don't
// need to send OFFSCREEN_STOP from here (doing so would race the new
// POPUP_AI_GENERATE in transit and could land *after* the new generate
// started, killing the wrong read).
function speakText(text) {
  if (!text) return;

  notifyPlaybackStarted('popup-speakText');

  // Stop any existing highlight before starting new speech
  sendHighlightMessage('STOP_HIGHLIGHT');

  sessionStorage.setItem('lastText', text);
  state.currentText = text;

  showPlaybackControls();
  // Optimistic UI: paint the playing state on the click frame instead of
  // waiting for the SW round-trip. The error path inside useAIVoiceTTS
  // resets it if the start actually fails.
  state.isPlaying = true;
  state.isPaused = false;
  updatePlayButton('playing');
  updateStatus('Preparing...');

  useAIVoiceTTS(text);
}

async function useAIVoiceTTS(text) {
  updateStatus('Generating speech...');
  const voice = state.currentVoice.replace('ai:', '');

  // For on-page reads (right-click selection), the SW drives highlight via
  // OFFSCREEN_SENTENCE_START → SENTENCE_START relay using the tabId we pass.
  // Typed text and test playback have shouldHighlight false and skip the
  // tabId.
  let tabId = null;
  if (state.shouldHighlight) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) tabId = tab.id;
    } catch (e) { /* couldn't query tab; proceed without highlight */ }
  }

  try {
    // Route through the service worker → offscreen document. The offscreen
    // owns the warm kokoro worker (survives popup close) and its
    // OFFSCREEN_GENERATE_AND_PLAY handler now resolves on the FIRST
    // streamed chunk's play(), not after the full paragraph generates —
    // so this await returns once audio actually starts.
    const reply = await chrome.runtime.sendMessage({
      target: 'service-worker',
      action: 'POPUP_AI_GENERATE',
      text: text,
      voice: voice,
      speed: state.currentSpeed,
      tabId: tabId
    });

    if (!reply || !reply.success) {
      throw new Error((reply && reply.error) || 'No response from service worker');
    }

    // Aborted = a newer generate superseded ours, or the user clicked stop
    // while we were still waiting for the first chunk. The newer flow (or
    // stop handler) is responsible for the UI; we just bail.
    if (reply.aborted) return;

    state.isPlaying = true;
    state.isPaused = false;
    updatePlayButton('playing');
    updateStatus('Reading...');
    // Cross-context end-of-playback UI (button → stopped, status →
    // "Finished", hide controls) is driven by the chrome.storage.onChanged
    // listener on `playbackActive`. The SW clears that flag on
    // OFFSCREEN_ENDED — set when the offscreen's ChunkedAudio finishes
    // its last chunk OR when the user stopped.
  } catch (error) {
    console.error('[GlowReadTTS] AI voice error:', error);
    updateStatus('AI voice error: ' + (error.message || 'unknown'));
    state.isPlaying = false;
    updatePlayButton('stopped');
    hidePlaybackControls();
    if (state.shouldHighlight) {
      sendHighlightMessage('STOP_HIGHLIGHT');
      state.shouldHighlight = false;
    }
    notifyPlaybackEnded('ai-exception');
  }
}

// Send highlight message to content script (best-effort, non-blocking)
async function sendHighlightMessage(action, data) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      const message = data ? Object.assign({ action: action }, data) : { action: action };
      chrome.tabs.sendMessage(tab.id, message, () => {
        // Silently ignore errors - highlight is best-effort
        // Content script may not be available on restricted pages
        if (chrome.runtime.lastError) { /* intentionally empty */ }
      });
    }
  } catch (e) {
    // Highlight is best-effort - never fail TTS due to highlight messaging
  }
}

// UI Helper Functions
function showPlaybackControls() {
  const section = document.getElementById('playback-section');
  if (section) {
    section.classList.add('active');
  }
}

function hidePlaybackControls() {
  const section = document.getElementById('playback-section');
  if (section) {
    section.classList.remove('active');
  }
}

function updatePlayButton(status) {
  const btn = document.getElementById('btn-play-pause');
  if (!btn) return;

  switch (status) {
    case 'playing':
      btn.innerHTML = icons.pause;
      btn.classList.add('playing');
      break;
    case 'paused':
      btn.innerHTML = icons.play;
      btn.classList.remove('playing');
      break;
    case 'stopped':
      btn.innerHTML = icons.play;
      btn.classList.remove('playing');
      break;
  }
}

function updateStatus(text) {
  const statusEl = document.getElementById('status-text');
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setSelectedButton(buttonId) {
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.classList.remove('selected');
  });
  
  const btn = document.getElementById(buttonId);
  if (btn) {
    btn.classList.add('selected');
    setTimeout(() => {
      btn.classList.remove('selected');
    }, 500);
  }
}

// Load saved settings
async function loadSavedSettings() {
  try {
    const savedText = sessionStorage.getItem('glowreadtts-text');
    if (savedText) {
      const textInput = document.getElementById('text-input');
      if (textInput) {
        textInput.value = savedText;
        handleTextInput({ target: textInput });
      }
    }

    const { isValidVoiceId } = await getVoiceCatalog();
    const result = await chrome.storage.sync.get(['voice', 'speed']);

    if (result.voice) {
      let voice = result.voice;

      // Migration paths to the locked default (DEFAULT_AI_VOICE):
      //   1. Saved voice is browser-TTS ('default' or a system voice name).
      //      Browser TTS was removed; legacy users must land on an AI voice.
      //   2. Saved voice is an AI id no longer in the shipped catalog
      //      (e.g. 'ai:am_adam' / 'ai:af_sky', dropped in v1).
      // Both write to BOTH storage keys (flat `voice` and nested
      // `settings.voice`) so the right-click flow (which reads independently
      // in the SW) doesn't keep firing on the stale value.
      const isAI = voice.startsWith('ai:');
      const isInvalidAI = isAI && !isValidVoiceId(voice.replace('ai:', ''));
      if (!isAI || isInvalidAI) {
        voice = DEFAULT_AI_VOICE;
        await chrome.storage.sync.set({ voice });
        const stored = await chrome.storage.sync.get('settings');
        const settings = stored.settings || {};
        await chrome.storage.sync.set({ settings: { ...settings, voice } });
      }

      state.currentVoice = voice;
      const voiceSelect = document.getElementById('voice-select');
      if (voiceSelect) {
        voiceSelect.value = voice;
      }
    } else {
      // First open ever (no stored voice). Persist the default so the SW
      // right-click path picks it up too.
      state.currentVoice = DEFAULT_AI_VOICE;
      await chrome.storage.sync.set({ voice: DEFAULT_AI_VOICE });
      const voiceSelect = document.getElementById('voice-select');
      if (voiceSelect) voiceSelect.value = DEFAULT_AI_VOICE;
    }

    if (result.speed) {
      // Defensive clamp: speed > 2.0 distorts kokoro inference enough that
      // the audio sounds garbled. Slider caps at 2.0, but stored values
      // from before the cap (3.0, 3.5, 4.0) need migration. Clamp on read
      // AND write back so any existing user with a stale value self-heals
      // on first popup open.
      const clampedSpeed = Math.max(0.25, Math.min(2.0, parseFloat(result.speed) || 1.0));
      state.currentSpeed = clampedSpeed;
      const speedSlider = document.getElementById('speed-slider');
      const speedValue = document.getElementById('speed-value');
      if (speedSlider) {
        speedSlider.value = clampedSpeed;
      }
      if (speedValue) {
        speedValue.textContent = `${clampedSpeed}x`;
      }
      // Migration write-back: if we clamped, persist the corrected value so
      // the right-click flow (which reads independently) also gets the fix.
      if (clampedSpeed !== result.speed) {
        chrome.storage.sync.set({ speed: clampedSpeed });
        // Match handleSpeedChange's dual-write pattern: also update the
        // nested settings.speed key if present.
        chrome.storage.sync.get('settings').then(stored => {
          if (stored.settings) {
            chrome.storage.sync.set({
              settings: { ...stored.settings, speed: clampedSpeed }
            });
          }
        });
      }
    }
  } catch (error) {
    console.error('[GlowReadTTS] Error loading settings:', error);
  }
}

console.log('[GlowReadTTS] Popup script loaded successfully');
