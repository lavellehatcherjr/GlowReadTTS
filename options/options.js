/**
 * GlowReadTTS Options Page
 */

const AI_CACHE_KEYS = ['transformers-cache', 'kokoro-voices'];

document.addEventListener('DOMContentLoaded', initOptions);

async function initOptions() {
  console.log('[GlowReadTTS Options] Initializing...');

  loadSettings();
  loadVoices();
  refreshCacheStatus();

  document.getElementById('speed-slider')?.addEventListener('input', updateSpeed);
  document.getElementById('default-voice')?.addEventListener('change', saveSettings);
  document.getElementById('btn-clear-ai-voices-cache')?.addEventListener('click', clearAIVoiceCache);
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(['settings']);
  if (settings.settings) {
    const s = settings.settings;

    if (s.voice) {
      document.getElementById('default-voice').value = s.voice;
    }

    if (s.speed) {
      document.getElementById('speed-slider').value = s.speed;
      document.getElementById('speed-value').textContent = `${s.speed}x`;
    }
  }
}

async function loadVoices() {
  chrome.tts.getVoices((voices) => {
    const select = document.getElementById('default-voice');

    const browserGroup = document.createElement('optgroup');
    browserGroup.label = 'Browser Voices';

    voices.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.voiceName;
      option.textContent = `${voice.voiceName} (${voice.lang || 'en'})`;
      browserGroup.appendChild(option);
    });

    select.appendChild(browserGroup);
  });
}

async function refreshCacheStatus() {
  const statusEl = document.getElementById('ai-voices-cache-status');
  if (!statusEl) return;
  try {
    let totalEntries = 0;
    for (const key of AI_CACHE_KEYS) {
      const cache = await caches.open(key);
      const keys = await cache.keys();
      totalEntries += keys.length;
    }
    if (totalEntries === 0) {
      statusEl.textContent = 'AI voices not installed.';
    } else {
      statusEl.textContent = `AI voice files cached: ${totalEntries} (cleared on demand).`;
    }
  } catch (e) {
    statusEl.textContent = 'Cache status unavailable.';
  }
}

async function clearAIVoiceCache() {
  const statusEl = document.getElementById('ai-voices-cache-status');
  const btn = document.getElementById('btn-clear-ai-voices-cache');

  // Confirm before deleting ~95MB of cached files.
  const confirmed = window.confirm(
    'Clear the AI voice cache? This will free approximately 95MB but you will need to download the AI voices again to use them.'
  );
  if (!confirmed) return;

  if (btn) btn.disabled = true;
  try {
    for (const key of AI_CACHE_KEYS) {
      await caches.delete(key);
    }
    await chrome.storage.local.remove('ai_voices_installed');
    if (statusEl) statusEl.textContent = 'AI voices not installed.';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Failed to clear cache: ' + (e.message || 'unknown');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateSpeed(e) {
  const speed = e.target.value;
  document.getElementById('speed-value').textContent = `${speed}x`;
  saveSettings();
}

async function saveSettings() {
  const formValues = {
    voice: document.getElementById('default-voice').value,
    speed: parseFloat(document.getElementById('speed-slider').value)
  };

  // Read existing settings first so a concurrent popup write to settings.voice
  // or settings.speed isn't clobbered by this save action.
  const stored = await chrome.storage.sync.get('settings');
  const merged = { ...(stored.settings || {}), ...formValues };

  // Dual-write: nested `settings` for the options page's reads, plus flat
  // `voice` and `speed` for the popup and service-worker context-menu flow.
  await chrome.storage.sync.set({
    settings: merged,
    voice: merged.voice,
    speed: merged.speed
  });
  console.log('[GlowReadTTS Options] Settings saved:', merged);
}

console.log('[GlowReadTTS Options] Page loaded');
