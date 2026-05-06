/**
 * GlowReadTTS Service Worker
 * Handles browser TTS context-menu reading, highlight relay, and PDF text extraction.
 */

import * as pdfjsLib from '../libs/pdfjs/pdf.mjs';

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdfjs/pdf.worker.mjs');
} catch (e) {
  console.log('[GlowReadTTS] PDF worker fallback: single-threaded mode');
}

console.log('[GlowReadTTS] Service worker starting...');

// Bumping this constant forces all users to re-accept the EULA on next launch.
const CURRENT_EULA_VERSION = '1.0';

const state = {
  isPlaying: false,
  highlightTabId: null
};

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

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[GlowReadTTS] Extension installed:', details);

  if (details.reason === 'install') {
    openEulaTab();
  }

  if (details.reason === 'update') {
    chrome.storage.local.remove('openai_api_key');
    const result = await chrome.storage.local.get(['eula_version']);
    if (result.eula_version !== CURRENT_EULA_VERSION) {
      openEulaTab();
    }
  }

  const defaults = {
    voice: 'default',
    speed: 1.0,
    autoPlay: true
  };

  const existing = await chrome.storage.sync.get('settings');
  if (!existing.settings) {
    await chrome.storage.sync.set({ settings: defaults });
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

  await speakFromServiceWorker(info.selectionText, tab.id);
});

/**
 * Speak text directly from the service worker (context-menu flow).
 * Loads saved voice/speed, starts browser TTS, drives sentence highlighting on the page.
 * Independent of the popup.
 */
async function speakFromServiceWorker(text, tabId) {
  if (!text || !tabId) return;

  chrome.tts.stop();

  if (state.highlightTabId) {
    sendToTab(state.highlightTabId, { action: 'STOP_HIGHLIGHT' });
  }

  const settings = await chrome.storage.sync.get(['voice', 'speed']);
  const voice = settings.voice || 'default';
  const speed = settings.speed || 1.0;

  state.highlightTabId = tabId;

  sendToTab(tabId, {
    action: 'START_HIGHLIGHT',
    text: text
  });

  const ttsOptions = {
    rate: speed,
    pitch: 1.0,
    volume: 1.0,
    desiredEventTypes: ['start', 'end', 'word', 'sentence', 'interrupted', 'cancelled', 'error'],
    onEvent: function(event) {
      if (event.type === 'start') {
        state.isPlaying = true;
      } else if (event.type === 'word' || event.type === 'sentence') {
        if (state.highlightTabId && typeof event.charIndex === 'number') {
          sendToTab(state.highlightTabId, {
            action: 'HIGHLIGHT_UPDATE',
            charIndex: event.charIndex
          });
        }
      } else if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
        state.isPlaying = false;
        if (state.highlightTabId) {
          sendToTab(state.highlightTabId, { action: 'STOP_HIGHLIGHT' });
          state.highlightTabId = null;
        }
      }
    }
  };

  if (voice !== 'default' && !voice.startsWith('ai:')) {
    ttsOptions.voiceName = voice;
  }

  // AI-prefixed voices aren't reachable from the context-menu path because the
  // service worker can't host the inference worker. Fall back to system default.
  chrome.tts.speak(text, ttsOptions);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Service Worker] Message received:', request.action);

  (async () => {
    try {
      switch (request.action) {
        case 'EXTRACT_PDF_TEXT':
          try {
            const pdfData = Uint8Array.from(atob(request.pdfData), c => c.charCodeAt(0));
            const pdf = await pdfjsLib.getDocument({ data: pdfData, isEvalSupported: false }).promise;
            let fullText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const content = await page.getTextContent();
              const pageText = content.items.map(item => item.str).join(' ');
              fullText += pageText + '\n\n';
            }
            fullText = fullText.trim().substring(0, 50000);
            if (!fullText) {
              sendResponse({ success: false, error: 'This PDF contains no readable text (may be a scanned image)' });
            } else {
              sendResponse({ success: true, text: fullText });
            }
          } catch (error) {
            console.error('[GlowReadTTS] PDF extraction error:', error);
            sendResponse({ success: false, error: 'Failed to extract text from PDF: ' + error.message });
          }
          break;

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
