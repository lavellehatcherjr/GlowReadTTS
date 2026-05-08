/**
 * GlowReadTTS Popup - Complete Version with Working Selection
 */

console.log('[GlowReadTTS] Popup script starting...');

// Global state
const state = {
  isPlaying: false,
  isPaused: false,
  currentVoice: 'default',
  currentSpeed: 1.0,
  currentText: '',
  selectedButton: null,
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

// Lazily-loaded AI voice manager (KokoroManager singleton)
let aiVoiceManager = null;
async function getAIVoiceManager() {
  if (!aiVoiceManager) {
    const mod = await import(chrome.runtime.getURL('libs/kokoro/kokoro-manager.js'));
    const KokoroManager = mod.default;
    aiVoiceManager = new KokoroManager();
  }
  return aiVoiceManager;
}

// Lazily-loaded voice catalog (single source of truth for shipped Kokoro voices).
let voiceCatalog = null;
async function getVoiceCatalog() {
  if (!voiceCatalog) {
    voiceCatalog = await import(chrome.runtime.getURL('libs/kokoro/voices-catalog.js'));
  }
  return voiceCatalog;
}

// Toggle visibility of both AI voice optgroups (American + British) together.
function setAIVoicesVisible(visible) {
  const value = visible ? 'block' : 'none';
  const american = document.getElementById('ai-voices-american');
  const british = document.getElementById('ai-voices-british');
  if (american) american.style.display = value;
  if (british) british.style.display = value;
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
  selection: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14M5 21h14M12 8v8M8 12h8"/></svg>',
  fileText: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/></svg>',
  upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>',
  settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  sparkles: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4M22 5h-4"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
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
    await loadSavedSettings();
    loadAvailableVoices();

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
  btn.style.cssText = 'padding: 10px 20px; background: #E8742C; color: #1A1815; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;';
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
  btn.style.cssText = 'margin-top: 10px; padding: 8px 16px; background: #E8742C; color: #1A1815; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;';
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
    return `<optgroup id="${id}" label="${label}" style="display:none;">
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
        <p>Free AI Voices. Total Privacy.</p>
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
          <button id="btn-read-selection" class="action-btn" title="Read selected text">
            <span class="action-icon">${icons.selection}</span>
            <span>Selection</span>
          </button>
          <button id="btn-read-page" class="action-btn" title="Read entire page">
            <span class="action-icon">${icons.fileText}</span>
            <span>Full Page</span>
          </button>
          <button id="btn-upload" class="action-btn" title="Upload text or PDF file">
            <span class="action-icon">${icons.upload}</span>
            <span>Upload</span>
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
        <!-- AI Voices Section -->
        <div id="ai-voices-section" class="ai-voices-section">
          <div class="ai-voices-title">${icons.sparkles} AI Voices (Offline & Free)</div>
          <div class="ai-voices-description">Download once, use forever. No internet needed after setup.</div>
          <div id="ai-voices-status" class="ai-voices-status">Not installed</div>
          <button id="btn-download-ai-voices" class="action-btn-primary" style="width:100%;">
            <span>${icons.download} Download AI Voices (~95MB)</span>
          </button>
          <div id="ai-voices-progress" class="ai-voices-progress hidden">
            <div id="ai-voices-progress-bar" class="ai-voices-progress-bar"></div>
          </div>
          <span id="ai-voices-progress-text" class="ai-voices-progress-text hidden">0%</span>
        </div>

        <!-- Voice Selection -->
        <div class="setting-group">
          <label class="setting-label">Voice</label>
          <select id="voice-select" class="select-input">
            <option value="default">System Default</option>
            <optgroup label="Browser Voices" id="browser-voices-group">
              <!-- Browser voices added dynamically -->
            </optgroup>
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
    const selectionBtn = document.getElementById('btn-read-selection');
    if (selectionBtn) {
      selectionBtn.addEventListener('click', handleReadSelection);
    }
    
    const pageBtn = document.getElementById('btn-read-page');
    if (pageBtn) {
      pageBtn.addEventListener('click', handleReadPage);
    }
    
    const uploadBtn = document.getElementById('btn-upload');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', handleUpload);
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

    const downloadBtn = document.getElementById('btn-download-ai-voices');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', handleDownloadAIVoices);
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

// Playback Control Handlers
function handlePlayPause() {
  const isAI = state.currentVoice.startsWith('ai:') && aiVoiceManager && aiVoiceManager.audio;
  if (state.isPlaying && !state.isPaused) {
    if (isAI) {
      aiVoiceManager.pause();
    } else {
      chrome.tts.pause();
    }
    state.isPaused = true;
    updatePlayButton('paused');
    updateStatus('Paused');
  } else if (state.isPaused) {
    if (isAI) {
      aiVoiceManager.resume();
    } else {
      chrome.tts.resume();
    }
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
  chrome.tts.stop();
  if (aiVoiceManager) {
    aiVoiceManager.stop();
    aiVoiceManager.dispose();
  }

  // Also stop any right-click AI read happening in the offscreen document.
  // The offscreen has its own KokoroManager and audio element. Its handleStop
  // sends OFFSCREEN_ENDED back to the SW, which relays STOP_HIGHLIGHT to the
  // page - closing the cleanup loop without relying on the watchdog.
  try {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_STOP'
    }, () => {
      if (chrome.runtime.lastError) {
        // Offscreen document may not exist yet; safe to ignore.
      }
    });
  } catch (e) { /* no offscreen doc */ }

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
    chrome.tts.stop();
    if (aiVoiceManager) aiVoiceManager.stop();

    // Also stop any right-click AI read happening in the offscreen document.
    // Mirrors handleStop. Without this, an in-flight offscreen AI read would
    // keep playing in parallel with the new restart.
    try {
      chrome.runtime.sendMessage(
        { target: 'offscreen', action: 'OFFSCREEN_STOP' },
        function() {
          if (chrome.runtime.lastError) {
            // Offscreen document may not exist yet; safe to ignore.
          }
        }
      );
    } catch (e) {
      // chrome.runtime may be unavailable in rare teardown timing; safe to ignore.
    }

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

// Action Button Handlers - COMPLETE IMPLEMENTATIONS
async function handleReadSelection() {
  setSelectedButton('btn-read-selection');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    chrome.tabs.sendMessage(tab.id, { action: 'GET_SELECTED_TEXT' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[GlowReadTTS] Need to inject content script');
        injectContentScript(tab, 'GET_SELECTED_TEXT');
      } else if (response && response.text) {
        console.log('[GlowReadTTS] Got selected text:', response.text.substring(0, 50) + '...');
        // Put the text in the input area
        const textInput = document.getElementById('text-input');
        if (textInput) {
          textInput.value = response.text;
          handleTextInput({ target: textInput });
        }
        state.shouldHighlight = true;  // Enable highlight-as-you-read for page text
        speakText(response.text);
      } else {
        updateStatus('No text selected');
      }
    });
  } catch (error) {
    console.error('Error:', error);
    updateStatus('Error reading selection');
  }
}

async function handleReadPage() {
  setSelectedButton('btn-read-page');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_TEXT' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[GlowReadTTS] Need to inject content script for page');
        injectContentScript(tab, 'GET_PAGE_TEXT');
      } else if (response && response.text) {
        console.log('[GlowReadTTS] Got page text, length:', response.text.length);
        // Truncate if too long for display
        const textInput = document.getElementById('text-input');
        if (textInput) {
          if (response.text.length > 5000) {
            const truncated = response.text.substring(0, 5000);
            textInput.value = truncated + '...\n[Display truncated. Full page text will still be read aloud.]';
          } else {
            textInput.value = response.text;
          }
          handleTextInput({ target: textInput });
        }
        state.shouldHighlight = true;  // Enable highlight-as-you-read for page text

        // Inform the user whether Reader Mode was applied. Subtle hint;
        // speakText's own status updates will overwrite this momentarily.
        if (response.usedReaderMode) {
          updateStatus('Reading article (Reader Mode)');
        } else {
          updateStatus('Reading page');
        }

        speakText(response.text);
      } else {
        updateStatus('No content found');
      }
    });
  } catch (error) {
    console.error('Error:', error);
    updateStatus('Error reading page');
  }
}

function handleUpload() {
  setSelectedButton('btn-upload');
  state.shouldHighlight = false;  // Uploaded text isn't on the page
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.json,.csv,.pdf';

  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.name.endsWith('.pdf')) {
        readPDFFile(file);
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;

        // Put text in input area
        const textInput = document.getElementById('text-input');
        if (textInput) {
          textInput.value = text;
          handleTextInput({ target: textInput });
        }

        speakText(text);
      };
      reader.onerror = () => {
        updateStatus('Failed to read file');
        hidePlaybackControls();
      };
      reader.readAsText(file);
    }
  };

  input.click();
}

function handleTestVoice() {
  setSelectedButton('btn-test');
  state.shouldHighlight = false;  // Test text isn't on the page

  // Branch the voice description on whether the current voice is AI or browser-based.
  const isAI = state.currentVoice && state.currentVoice.startsWith('ai:');
  const voiceLabel = isAI ? 'an AI voice' : 'a browser text-to-speech voice';

  const testText = "Hello! This is a test of the GlowReadTTS text-to-speech system. " +
                   "You're currently listening to " + voiceLabel + " at " +
                   state.currentSpeed + "x speed.";
  speakText(testText);
}

function readPDFFile(file) {
  updateStatus('Extracting text from PDF...');
  showPlaybackControls();

  const reader = new FileReader();
  reader.onload = (event) => {
    const arrayBuffer = event.target.result;
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64String = btoa(binary);

    chrome.runtime.sendMessage(
      { action: 'EXTRACT_PDF_TEXT', pdfData: base64String },
      (response) => {
        if (response && response.success) {
          const textInput = document.getElementById('text-input');
          if (textInput) {
            let displayText = response.text;
            if (response.truncated) {
              displayText = response.text +
                '\n\n[PDF was truncated to 50,000 characters. Original was ' +
                response.originalLength.toLocaleString() + ' characters.]';
            }
            textInput.value = displayText;
            handleTextInput({ target: textInput });
          }
          speakText(response.text);  // Read only the truncated portion
        } else {
          const errorMsg = (response && response.error) ||
            'This PDF contains no readable text (may be a scanned image)';
          updateStatus(errorMsg);
          hidePlaybackControls();
        }
      }
    );
  };

  reader.onerror = () => {
    updateStatus('Failed to read PDF file');
    hidePlaybackControls();
  };

  reader.readAsArrayBuffer(file);
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

// Splits long text into chunks at sentence boundaries for chrome.tts.
// chrome.tts has a documented 32,768 char limit but voices fail silently
// on much smaller amounts (often a few thousand chars for network voices).
// 400 chars per chunk is a conservative ceiling that works reliably across
// system voices, Google network voices, and Microsoft SAPI voices.
// Splits at sentence-ending punctuation (. ! ?) followed by whitespace.
// Falls back to whitespace splitting if no sentence boundary fits within
// the chunk size, then to hard cut as last resort.
function chunkTextForTTS(text, maxChunkSize = 400) {
  if (!text || text.length <= maxChunkSize) {
    return [text];
  }
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxChunkSize) {
    let cutPoint = -1;
    const searchEnd = Math.min(remaining.length, maxChunkSize);
    // Prefer sentence boundary
    for (let i = searchEnd - 1; i >= Math.floor(maxChunkSize / 2); i--) {
      const c = remaining[i];
      if ((c === '.' || c === '!' || c === '?') &&
          (i === remaining.length - 1 || /\s/.test(remaining[i + 1]))) {
        cutPoint = i + 1;
        break;
      }
    }
    // Fall back to whitespace
    if (cutPoint === -1) {
      for (let i = searchEnd - 1; i >= Math.floor(maxChunkSize / 2); i--) {
        if (/\s/.test(remaining[i])) {
          cutPoint = i + 1;
          break;
        }
      }
    }
    // Hard cut as last resort
    if (cutPoint === -1) {
      cutPoint = maxChunkSize;
    }
    chunks.push(remaining.slice(0, cutPoint).trim());
    remaining = remaining.slice(cutPoint).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

// Main TTS Function
function speakText(text) {
  if (!text) return;

  notifyPlaybackStarted('popup-speakText');

  chrome.tts.stop();
  if (aiVoiceManager) aiVoiceManager.stop();

  // Stop any existing highlight before starting new speech
  sendHighlightMessage('STOP_HIGHLIGHT');

  sessionStorage.setItem('lastText', text);
  state.currentText = text;

  showPlaybackControls();
  updateStatus('Preparing...');

  if (state.currentVoice.startsWith('ai:')) {
    useAIVoiceTTS(text);
  } else {
    // Browser TTS: word boundary events drive highlight position
    if (state.shouldHighlight) {
      sendHighlightMessage('START_HIGHLIGHT', { text: text });
    }
    useBrowserTTS(text);
  }
}

async function useAIVoiceTTS(text) {
  updateStatus('Generating speech...');
  const voice = state.currentVoice.replace('ai:', '');

  try {
    const mgr = await getAIVoiceManager();
    const audio = await mgr.generate(text, voice, state.currentSpeed);

    state.isPlaying = true;
    state.isPaused = false;
    updatePlayButton('playing');
    updateStatus('Reading...');

    // Highlight: AI audio doesn't emit word boundaries, so drive highlights via
    // timeupdate -> HIGHLIGHT_PROGRESS (proportional sentence advance).
    if (state.shouldHighlight) {
      const estimatedMs = (Number.isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration * 1000
        : (text.length / 15) * 1000;
      sendHighlightMessage('START_HIGHLIGHT', { text: text, estimatedDurationMs: estimatedMs });

      audio.addEventListener('timeupdate', () => {
        if (mgr.audio === audio) {
          sendHighlightMessage('HIGHLIGHT_PROGRESS', {
            currentTime: audio.currentTime,
            duration: audio.duration
          });
        }
      });
    }

    audio.addEventListener('ended', () => {
      state.isPlaying = false;
      state.isPaused = false;
      updatePlayButton('stopped');
      updateStatus('Finished');
      if (state.shouldHighlight) {
        sendHighlightMessage('STOP_HIGHLIGHT');
        state.shouldHighlight = false;
      }
      // Free RAM once playback finishes
      mgr.dispose();
      setTimeout(() => hidePlaybackControls(), 2000);
      notifyPlaybackEnded('ai-natural-end');
    });

    audio.addEventListener('error', () => {
      state.isPlaying = false;
      updateStatus('AI voice playback error');
      updatePlayButton('stopped');
      hidePlaybackControls();
      if (state.shouldHighlight) {
        sendHighlightMessage('STOP_HIGHLIGHT');
        state.shouldHighlight = false;
      }
      notifyPlaybackEnded('ai-error');
    });
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

async function handleDownloadAIVoices() {
  const btn = document.getElementById('btn-download-ai-voices');
  const statusEl = document.getElementById('ai-voices-status');
  const progressWrap = document.getElementById('ai-voices-progress');
  const progressBar = document.getElementById('ai-voices-progress-bar');
  const progressText = document.getElementById('ai-voices-progress-text');

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Downloading...';
  if (progressWrap) progressWrap.classList.remove('hidden');
  if (progressText) progressText.classList.remove('hidden');

  try {
    const mgr = await getAIVoiceManager();
    await mgr.downloadModel((loaded, total) => {
      if (total > 0 && progressBar && progressText) {
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        progressBar.style.width = pct + '%';
        progressText.textContent = pct + '%';
      }
    });

    chrome.storage.local.set({ ai_voices_installed: true });
    if (statusEl) {
      statusEl.textContent = 'Installed. Select an AI voice in the Voice dropdown below.';
      statusEl.style.color = 'var(--success, #10B981)';
    }
    if (btn) btn.style.display = 'none';
    if (progressWrap) progressWrap.classList.add('hidden');
    if (progressText) progressText.classList.add('hidden');
    setAIVoicesVisible(true);

    // Briefly highlight the Voice dropdown to draw attention to where AI voices live.
    const voiceSelectEl = document.getElementById('voice-select');
    if (voiceSelectEl) {
      voiceSelectEl.style.transition = 'box-shadow 1.5s ease';
      voiceSelectEl.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.4)';
      setTimeout(() => {
        voiceSelectEl.style.boxShadow = '';
      }, 2500);
    }
  } catch (error) {
    console.error('[GlowReadTTS] AI voice download error:', error);
    if (statusEl) statusEl.textContent = 'Download failed: ' + (error.message || 'unknown');
    if (btn) btn.disabled = false;
    if (progressWrap) progressWrap.classList.add('hidden');
    if (progressText) progressText.classList.add('hidden');
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

function useBrowserTTS(text) {
  chrome.tts.stop();

  const options = {
    rate: state.currentSpeed,
    pitch: 1.0,
    volume: 1.0,
    // Request word/sentence boundary events for highlight tracking
    desiredEventTypes: ['start', 'end', 'word', 'sentence', 'interrupted', 'cancelled', 'error', 'pause', 'resume']
  };

  if (state.currentVoice !== 'default') {
    options.voiceName = state.currentVoice;
  }

  // Bug A fix: chrome.tts voices fail silently on long text (Google network
  // voices fail at a few thousand chars even though spec says 32K limit).
  // Split at sentence boundaries and queue with enqueue:true so voices stay
  // within their working range while audio plays continuously.
  const chunks = chunkTextForTTS(text);
  console.log('[GlowReadTTS] Speaking', chunks.length, 'chunk(s) totalling', text.length, 'chars');

  // Track cumulative offset so 'word'/'sentence' events map back to the full
  // text's character positions, not the chunk being spoken. Without this,
  // each chunk boundary would cause the on-page highlight to jump back to
  // sentence 1 of the article (event.charIndex resets to 0 per chunk).
  let cumulativeOffset = 0;

  chunks.forEach((chunk, index) => {
    const isLastChunk = index === chunks.length - 1;
    // Capture this chunk's start offset for the closure (event handlers
    // fire later when chunk is being spoken, after the loop has advanced).
    const chunkStartOffset = cumulativeOffset;
    // Advance offset for next chunk. +1 accounts for the trim/space lost
    // between chunks (chunkTextForTTS calls .trim() which strips whitespace).
    cumulativeOffset += chunk.length + 1;

    const chunkOptions = {
      ...options,
      enqueue: index > 0,
      onEvent: (event) => {
        if (event.type === 'start' && index === 0) {
          state.isPlaying = true;
          state.isPaused = false;
          updatePlayButton('playing');
          updateStatus('Reading...');
        } else if ((event.type === 'word' || event.type === 'sentence') &&
                   state.shouldHighlight && typeof event.charIndex === 'number') {
          // CHANGED FROM ORIGINAL: charIndex is per-chunk; add chunkStartOffset
          // so the highlight maps to positions in the full original text.
          sendHighlightMessage('HIGHLIGHT_UPDATE', {
            charIndex: chunkStartOffset + event.charIndex
          });
        } else if ((event.type === 'end' || event.type === 'interrupted' ||
                    event.type === 'cancelled') && isLastChunk) {
          state.isPlaying = false;
          state.isPaused = false;
          updatePlayButton('stopped');
          updateStatus(event.type === 'end' ? 'Finished' : 'Stopped');
          // Clean up highlighting
          if (state.shouldHighlight) {
            sendHighlightMessage('STOP_HIGHLIGHT');
            state.shouldHighlight = false;
          }
          if (event.type === 'end') {
            setTimeout(() => hidePlaybackControls(), 2000);
          } else {
            hidePlaybackControls();
          }
          notifyPlaybackEnded('browser-tts-end');
        } else if (event.type === 'error') {
          chrome.tts.stop();  // flush any remaining queued chunks
          state.isPlaying = false;
          updateStatus('Error: ' + (event.errorMessage || 'Unknown'));
          updatePlayButton('stopped');
          if (state.shouldHighlight) {
            sendHighlightMessage('STOP_HIGHLIGHT');
            state.shouldHighlight = false;
          }
          hidePlaybackControls();
          notifyPlaybackEnded('browser-tts-error');
        }
      }
    };
    chrome.tts.speak(chunk, chunkOptions);
  });
}

// Content Script Injection - COMPLETE IMPLEMENTATION
async function injectContentScript(tab, action) {
  if (!tab.url || tab.url.startsWith('chrome://') || 
      tab.url.startsWith('edge://') || 
      tab.url.startsWith('chrome-extension://')) {
    updateStatus('Cannot read this type of page');
    return;
  }
  
  try {
    console.log('[GlowReadTTS] Injecting content script...');
    
    // Note: This inline fallback intentionally uses innerText, not Readability.
    // It only fires when the persistent content script is unavailable on the
    // active tab. The persistent content script (which uses Readability via the
    // GET_PAGE_TEXT handler) handles the common case.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (!window.GlowReadTTSInjected) {
          window.GlowReadTTSInjected = true;

          chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'GET_SELECTED_TEXT') {
              const selectedText = window.getSelection().toString();
              console.log('[Content] Sending selected text:', selectedText.substring(0, 50));
              sendResponse({ text: selectedText });
            } else if (request.action === 'GET_PAGE_TEXT') {
              const pageText = document.body ? document.body.innerText : '';
              console.log('[Content] Sending page text, length:', pageText.length);
              sendResponse({ text: pageText });
            }
            return true;
          });
        }
      }
    });
    
    // Small delay then retry the message
    setTimeout(() => {
      console.log('[GlowReadTTS] Sending message after injection:', action);
      chrome.tabs.sendMessage(tab.id, { action }, (response) => {
        if (response && response.text) {
          console.log('[GlowReadTTS] Got text after injection:', response.text.substring(0, 50) + '...');
          // Put text in input area
          const textInput = document.getElementById('text-input');
          if (textInput) {
            if (action === 'GET_PAGE_TEXT' && response.text.length > 5000) {
              const truncated = response.text.substring(0, 5000);
              textInput.value = truncated + '...\n[Display truncated. Full page text will still be read aloud.]';
            } else {
              textInput.value = response.text;
            }
            handleTextInput({ target: textInput });
          }
          speakText(response.text);
        } else {
          updateStatus('No text found');
        }
      });
    }, 100);
    
  } catch (error) {
    console.error('[Inject] Failed:', error);
    updateStatus('Cannot read this page');
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

      // Migration: if the saved voice is an AI voice ID that's no longer in the
      // shipped catalog (e.g. 'ai:am_adam' or 'ai:af_sky', dropped in v1), move
      // the user to the locked default 'ai:af_heart' and write to BOTH storage
      // locations to keep the dual-write inconsistency from drifting.
      if (voice.startsWith('ai:') && !isValidVoiceId(voice.replace('ai:', ''))) {
        // Notify user via the visible AI voices status row (writing to the
        // playback status would be invisible - that section is hidden until a
        // read starts).
        const aiStatusEl = document.getElementById('ai-voices-status');
        if (aiStatusEl) {
          aiStatusEl.textContent = 'Your previous AI voice is no longer available - defaulted to Heart';
          aiStatusEl.style.color = 'var(--warning, #F59E0B)';
        }

        voice = 'ai:af_heart';
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
    }

    if (result.speed) {
      // Defensive clamp: chrome.tts voices have rate ceilings (Google network
      // voices verified to silently no-op above 2.0; other voices likely similar).
      // Slider HTML now caps at 2.0, but stored values from before the cap
      // (3.0, 3.5, 4.0) need migration. Clamp on read AND write back so any
      // existing user with a stale value self-heals on first popup open.
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

    // If AI voices were previously installed, surface the AI voice options.
    const localResult = await chrome.storage.local.get(['ai_voices_installed']);
    if (localResult.ai_voices_installed) {
      try {
        const mgr = await getAIVoiceManager();
        const cached = await mgr.isModelCached();
        if (cached) {
          setAIVoicesVisible(true);
          const statusEl = document.getElementById('ai-voices-status');
          if (statusEl) statusEl.textContent = 'Installed';
          const btn = document.getElementById('btn-download-ai-voices');
          if (btn) btn.style.display = 'none';
        }
      } catch (e) { /* best effort */ }
    }
  } catch (error) {
    console.error('[GlowReadTTS] Error loading settings:', error);
  }
}

// Load available voices
async function loadAvailableVoices() {
  try {
    chrome.tts.getVoices((voices) => {
      const browserGroup = document.getElementById('browser-voices-group');

      if (browserGroup && voices) {
        voices.forEach(voice => {
          if (voice.voiceName) {
            const option = document.createElement('option');
            option.value = voice.voiceName;
            option.textContent = `${voice.voiceName} (${voice.lang || 'en'})`;
            browserGroup.appendChild(option);
          }
        });
      }
      const voiceSelectEl = document.getElementById('voice-select');

      // Bug B fix: chrome.tts.getVoices() is async and populates the dropdown
      // AFTER loadSavedSettings has already tried to set dropdown.value. By
      // the time browser voices arrive, dropdown.value has settled to default
      // because the saved voice wasn't yet in the options list.
      // Re-apply state.currentVoice now that all voices are present.
      if (state.currentVoice && voiceSelectEl) {
        const savedVoiceOption = Array.from(voiceSelectEl.options).find(
          opt => opt.value === state.currentVoice
        );
        if (savedVoiceOption) {
          voiceSelectEl.value = state.currentVoice;
          console.log('[GlowReadTTS] Re-applied saved voice after voice population:', state.currentVoice);
        } else {
          // Saved voice no longer exists (uninstalled, voice list changed, etc.)
          // Leave dropdown at its current default and clear stale state.
          console.log('[GlowReadTTS] Saved voice no longer available:', state.currentVoice);
          state.currentVoice = voiceSelectEl.value;
        }
      }
    });
  } catch (error) {
    console.error('[GlowReadTTS] Error loading voices:', error);
  }
}

console.log('[GlowReadTTS] Popup script loaded successfully');
