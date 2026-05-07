/**
 * Offscreen document that owns a KokoroManager for the right-click context-menu
 * AI voice flow. The service worker can't host the inference worker or play
 * <Audio>, so it routes generation requests here. This document stays alive
 * for the browser session; the manager and worker persist across requests.
 */

import KokoroManager from '../libs/kokoro/kokoro-manager.js';

let manager = null;

// Track the tab whose highlight we're driving so handleStop can also clean up.
let currentTabId = null;

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
    handleGenerateAndPlay(msg.text, msg.voice, msg.speed, msg.tabId)
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

async function handleGenerateAndPlay(text, voice, speed, tabId) {
  const mgr = getManager();
  const audio = await mgr.generate(text, voice, speed);

  // Track the active tab so handleStop can also send OFFSCREEN_ENDED for
  // highlight cleanup (mgr.stop() does NOT fire `ended`/`error`, so without
  // explicit signaling, the page highlight would stay until the watchdog
  // catches it ~60s later).
  currentTabId = tabId || null;

  // If a tabId was provided, relay timeupdate progress so the content script
  // can advance the highlight in real time. Without this, AI right-click reads
  // would have no on-page highlight (asymmetric with system TTS reads).
  if (tabId && audio) {
    const onTimeUpdate = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      try {
        chrome.runtime.sendMessage({
          target: 'service-worker',
          action: 'OFFSCREEN_PROGRESS',
          tabId: tabId,
          currentTime: audio.currentTime,
          duration: audio.duration
        });
      } catch (e) { /* SW may be torn down; safe to ignore */ }
    };
    const onEnded = () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onEnded);
      try {
        chrome.runtime.sendMessage({
          target: 'service-worker',
          action: 'OFFSCREEN_ENDED',
          tabId: tabId
        });
      } catch (e) { /* ignore */ }
      // Clear currentTabId only if it still matches this tab (a newer
      // generate() may have already replaced it).
      if (currentTabId === tabId) currentTabId = null;
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onEnded);
  }

  return audio;
}

function handleStop() {
  if (manager) manager.stop();

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
