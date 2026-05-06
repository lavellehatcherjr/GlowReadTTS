/**
 * Offscreen document that owns a KokoroManager for the right-click context-menu
 * AI voice flow. The service worker can't host the inference worker or play
 * <Audio>, so it routes generation requests here. This document stays alive
 * for the browser session; the manager and worker persist across requests.
 */

import KokoroManager from '../libs/kokoro/kokoro-manager.js';

let manager = null;

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
    handleGenerateAndPlay(msg.text, msg.voice, msg.speed)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({
        success: false,
        error: err && err.message ? err.message : String(err)
      }));
    return true;
  }

  if (msg.action === 'OFFSCREEN_STOP') {
    handleStop();
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_PING') {
    sendResponse({ success: true });
    return false;
  }

  return false;
});

async function handleGenerateAndPlay(text, voice, speed) {
  const mgr = getManager();
  // mgr.generate() resolves once playback starts; the audio element keeps
  // playing in this document until it ends or is stopped.
  await mgr.generate(text, voice, speed);
}

function handleStop() {
  if (manager) manager.stop();
}
