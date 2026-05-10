/**
 * GlowReadTTS Options Page
 */

document.addEventListener('DOMContentLoaded', initOptions);

async function initOptions() {
  console.log('[GlowReadTTS Options] Initializing...');

  // Order matters: populate the voice dropdown completely before applying
  // the saved value. Setting <select>.value to an option that doesn't yet
  // exist silently falls back to the first option, and a subsequent save
  // would persist that fallback as the user's "new" voice.
  await populateAIVoices();
  await applySavedVoice();
  await loadSpeedSetting();
  await loadPrewarmSetting();

  document.getElementById('speed-slider')?.addEventListener('input', updateSpeed);
  document.getElementById('default-voice')?.addEventListener('change', saveSettings);
  document.getElementById('prewarm-toggle')?.addEventListener('change', savePrewarmSetting);
}

// Selection-prewarm toggle. Stored as a flat boolean key in
// chrome.storage.local (NOT sync) — this is a per-device performance
// preference and shouldn't follow the user across machines with
// different RAM budgets. Default true (matches the default written by
// service-worker.js's onInstalled handler).
async function loadPrewarmSetting() {
  const stored = await chrome.storage.local.get('prewarmOnSelection');
  const enabled = (typeof stored.prewarmOnSelection === 'boolean')
    ? stored.prewarmOnSelection
    : true;
  const checkbox = document.getElementById('prewarm-toggle');
  if (checkbox) checkbox.checked = enabled;
}

async function savePrewarmSetting(e) {
  const enabled = !!e.target.checked;
  await chrome.storage.local.set({ prewarmOnSelection: enabled });
  console.log('[GlowReadTTS Options] prewarmOnSelection =', enabled);
}

// Add the bundled Kokoro AI voices, mirroring the popup's two optgroups.
// AI-only since browser TTS was removed; the dropdown's first option is
// the System Default placeholder kept as a migration-safe value for
// pre-AI-only saves (applySavedVoice falls back to it if the saved id
// is no longer in the catalog).
async function populateAIVoices() {
  try {
    const mod = await import(chrome.runtime.getURL('libs/kokoro/voices-catalog.js'));
    const select = document.getElementById('default-voice');
    if (!select) return;

    const buildOptgroup = (langCode, label) => {
      const group = document.createElement('optgroup');
      group.label = label;
      mod.voicesByLanguage(langCode).forEach(v => {
        const opt = document.createElement('option');
        opt.value = `ai:${v.id}`;
        opt.textContent = `${v.displayName} - ${v.tagline}`;
        group.appendChild(opt);
      });
      return group;
    };

    select.appendChild(buildOptgroup('a', '🇺🇸 American English'));
    select.appendChild(buildOptgroup('b', '🇬🇧 British English'));
  } catch (e) {
    console.error('[GlowReadTTS Options] Failed to load AI voice catalog:', e);
  }
}

async function applySavedVoice() {
  const select = document.getElementById('default-voice');
  if (!select) return;
  const stored = await chrome.storage.sync.get(['voice', 'settings']);
  const saved = stored.voice || (stored.settings && stored.settings.voice);
  if (!saved) return;
  const matches = Array.from(select.options).some(opt => opt.value === saved);
  if (matches) {
    select.value = saved;
  }
  // If saved doesn't match (e.g. a removed voice, or a stale browser-TTS
  // voice from before the AI-only migration), leave the dropdown at its
  // built-in default. saveSettings only fires from explicit user input,
  // so we won't auto-persist that fallback.
}

async function loadSpeedSetting() {
  const stored = await chrome.storage.sync.get(['speed', 'settings']);
  const raw = stored.speed
    ?? (stored.settings && stored.settings.speed)
    ?? 1.0;
  const speed = Math.max(0.25, Math.min(2.0, parseFloat(raw) || 1.0));
  const slider = document.getElementById('speed-slider');
  const value = document.getElementById('speed-value');
  if (slider) slider.value = speed;
  if (value) value.textContent = `${speed}x`;
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
