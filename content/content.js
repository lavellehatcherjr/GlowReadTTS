/**
 * GlowReadTTS Content Script
 * Handles text selection, page interaction, and highlight-as-you-read
 *
 * SECURITY NOTES:
 * - Primary: CSS Custom Highlight API (zero DOM modification - styles Range objects)
 * - Fallback: classList toggling on existing block elements
 * - No innerHTML, insertAdjacentHTML, eval(), or document.write() anywhere
 * - No external dependencies
 */

'use strict';

console.log('[GlowReadTTS] Content script loaded');

// ============================================
// Highlight-as-you-read Module
// Primary: CSS Custom Highlight API (Range-based, zero DOM changes)
// Fallback: CSS class toggling on block elements
// ============================================
const GlowReadTTSHighlight = (() => {

  // --- Constants ---
  const HIGHLIGHT_NAME = 'glowreadtts-reading';
  const READING_CLASS = 'glowreadtts-reading-active';
  const FALLBACK_CLASS = 'glowreadtts-sentence-active';
  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, dd, dt, figcaption, caption, summary';

  // Feature detection: CSS Custom Highlight API (Chrome 105+, we require 120+)
  const hasHighlightAPI = (typeof CSS !== 'undefined' && 'highlights' in CSS);

  // --- State ---
  let sentences = [];
  let activeSentenceIdx = -1;
  let isHighlightActive = false;
  let autoAdvanceTimer = null;

  // CSS Highlight API state
  let sentenceRanges = [];    // Range per sentence (or null)
  let currentHighlight = null;

  // classList fallback state
  let sentenceBlockMap = [];

  // --- Watchdog: clean up stale highlights ---
  // If no UPDATE/PROGRESS message arrives for WATCHDOG_TIMEOUT_MS while the
  // highlight is active, assume the driver (popup or service worker context)
  // was torn down and clean up. Higher timeout (60s) accommodates voices that
  // don't fire word/sentence boundary events on some platforms.
  let lastUpdateAt = 0;
  let watchdogTimer = null;
  const WATCHDOG_INTERVAL_MS = 5000;
  const WATCHDOG_TIMEOUT_MS = 60000;

  function startWatchdog() {
    stopWatchdog();
    lastUpdateAt = Date.now();
    watchdogTimer = setInterval(() => {
      if (!isHighlightActive) {
        stopWatchdog();
        return;
      }
      if (Date.now() - lastUpdateAt > WATCHDOG_TIMEOUT_MS) {
        console.log('[GlowReadTTS] Highlight watchdog: no update in 60s, cleaning up');
        cleanup();
        stopWatchdog();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function noteUpdate() {
    lastUpdateAt = Date.now();
  }

  // --- Sentence Splitting ---
  // Splits text into sentences with character offset tracking.
  // Handles ., !, ? followed by whitespace, and paragraph breaks.
  function splitIntoSentences(text) {
    const result = [];
    let current = '';
    let startChar = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      current += char;

      const isEndPunct = (char === '.' || char === '!' || char === '?');
      const nextIsSpaceOrEnd = (i === text.length - 1 || /\s/.test(text[i + 1]));
      const isParaBreak = (char === '\n' && i + 1 < text.length && text[i + 1] === '\n');

      if ((isEndPunct && nextIsSpaceOrEnd) || isParaBreak) {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          result.push({ text: trimmed, startChar: startChar, endChar: i + 1 });
        }
        while (i + 1 < text.length && /\s/.test(text[i + 1])) { i++; }
        startChar = i + 1;
        current = '';
      }
    }

    const remaining = current.trim();
    if (remaining.length > 0) {
      result.push({ text: remaining, startChar: startChar, endChar: text.length });
    }

    return result;
  }

  // --- Char-to-Sentence Lookup ---
  function getSentenceIndexForChar(charIndex) {
    for (let i = 0; i < sentences.length; i++) {
      if (charIndex >= sentences[i].startChar && charIndex < sentences[i].endChar) {
        return i;
      }
    }
    if (sentences.length > 0 && charIndex >= sentences[sentences.length - 1].startChar) {
      return sentences.length - 1;
    }
    return 0;
  }

  // --- Get Visible Text Nodes ---
  // Uses TreeWalker to safely enumerate text nodes without modifying DOM.
  function getVisibleTextNodes() {
    if (!document.body) return [];
    const nodes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
              tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') {
            return NodeFilter.FILTER_REJECT;
          }
          // Skip invisible elements (offsetParent null = hidden,
          // except position:fixed which is visible)
          try {
            if (parent.offsetParent === null && parent.offsetHeight === 0 &&
                getComputedStyle(parent).position !== 'fixed') {
              return NodeFilter.FILTER_REJECT;
            }
          } catch (e) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.textContent.trim().length === 0) {
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    return nodes;
  }

  // --- Normalized Text Mapping ---
  // Collapses whitespace and builds a position map from normalized→raw indices.
  // This allows matching innerText sentences (whitespace-normalized) against
  // raw DOM text node content.
  function buildNormalizedMap(rawText) {
    let normalized = '';
    const toRaw = []; // toRaw[normalizedIdx] = rawIdx
    let prevWasSpace = true; // Start true to trim leading whitespace

    for (let i = 0; i < rawText.length; i++) {
      const ch = rawText[i];
      if (/\s/.test(ch)) {
        if (!prevWasSpace) {
          toRaw.push(i);
          normalized += ' ';
          prevWasSpace = true;
        }
      } else {
        toRaw.push(i);
        normalized += ch;
        prevWasSpace = false;
      }
    }

    // Trim trailing space
    if (normalized.endsWith(' ')) {
      normalized = normalized.slice(0, -1);
      toRaw.pop();
    }

    return { normalized: normalized, toRaw: toRaw };
  }

  // --- Create Range from raw text positions ---
  // Maps character positions in the accumulated raw text to DOM Range objects.
  // SECURITY: Uses only new Range(), setStart(), setEnd() - no DOM modification.
  function createRangeFromPositions(rawStart, rawEnd, nodeMap) {
    let startNode = null, startOffset = 0;
    let endNode = null, endOffset = 0;

    for (let k = 0; k < nodeMap.length; k++) {
      const nm = nodeMap[k];
      if (!startNode && rawStart < nm.rawEnd) {
        startNode = nm.node;
        startOffset = rawStart - nm.rawStart;
      }
      if (rawEnd <= nm.rawEnd) {
        endNode = nm.node;
        endOffset = rawEnd - nm.rawStart;
        break;
      }
    }

    if (!startNode || !endNode) return null;
    if (startOffset < 0 || startOffset > startNode.textContent.length) return null;
    if (endOffset < 0 || endOffset > endNode.textContent.length) return null;

    try {
      const range = new Range();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch (e) {
      return null;
    }
  }

  // --- Build Sentence Ranges (CSS Custom Highlight API) ---
  // Walks visible text nodes, builds accumulated text, then creates Range
  // objects for each sentence using normalized text matching.
  function buildSentenceRanges() {
    sentenceRanges = [];

    const textNodes = getVisibleTextNodes();
    if (textNodes.length === 0) return;

    // Accumulate raw text from all visible text nodes
    let rawText = '';
    const nodeMap = [];
    for (let i = 0; i < textNodes.length; i++) {
      const start = rawText.length;
      rawText += textNodes[i].textContent;
      nodeMap.push({ node: textNodes[i], rawStart: start, rawEnd: rawText.length });
    }

    // Build normalized version for fuzzy matching
    const map = buildNormalizedMap(rawText);
    const normalized = map.normalized;
    const toRaw = map.toRaw;

    let searchFrom = 0;

    for (let si = 0; si < sentences.length; si++) {
      const needle = sentences[si].text.replace(/\s+/g, ' ').trim();
      if (needle.length < 3) {
        sentenceRanges.push(null);
        continue;
      }

      // Try exact normalized match first
      let normIdx = normalized.indexOf(needle, searchFrom);

      // Fallback: case-insensitive
      if (normIdx === -1) {
        normIdx = normalized.toLowerCase().indexOf(needle.toLowerCase(), searchFrom);
      }

      if (normIdx === -1 || normIdx + needle.length - 1 >= toRaw.length) {
        sentenceRanges.push(null);
        continue;
      }

      const rawStart = toRaw[normIdx];
      const rawEnd = toRaw[normIdx + needle.length - 1] + 1;
      const range = createRangeFromPositions(rawStart, rawEnd, nodeMap);
      sentenceRanges.push(range);
      searchFrom = normIdx + needle.length;
    }
  }

  // --- Map Sentences to Block Elements (classList fallback) ---
  function mapSentencesToBlocks() {
    const allBlocks = document.querySelectorAll(BLOCK_SELECTOR);
    const visibleBlocks = [];
    for (let i = 0; i < allBlocks.length; i++) {
      const el = allBlocks[i];
      if (el.offsetParent !== null || el.offsetHeight > 0) {
        visibleBlocks.push(el);
      }
    }

    sentenceBlockMap = [];
    let blockSearchStart = 0;

    for (let i = 0; i < sentences.length; i++) {
      const needle = sentences[i].text;
      if (needle.length < 3) { sentenceBlockMap.push(null); continue; }

      let found = false;
      const normalizedNeedle = needle.replace(/\s+/g, ' ');
      for (let j = blockSearchStart; j < visibleBlocks.length; j++) {
        const blockText = visibleBlocks[j].textContent;
        if (blockText.includes(needle) ||
            blockText.replace(/\s+/g, ' ').includes(normalizedNeedle)) {
          sentenceBlockMap.push(visibleBlocks[j]);
          blockSearchStart = j;
          found = true;
          break;
        }
      }
      if (!found) sentenceBlockMap.push(null);
    }
  }

  // --- Highlight a Sentence ---
  function highlightSentence(index) {
    if (!isHighlightActive) return;
    if (index === activeSentenceIdx) return;
    if (index < 0 || index >= sentences.length) return;

    activeSentenceIdx = index;

    if (hasHighlightAPI) {
      highlightWithAPI(index);
    } else {
      highlightWithClassList(index);
    }
  }

  // CSS Custom Highlight API path - zero DOM modification
  function highlightWithAPI(index) {
    const range = sentenceRanges[index];
    if (!range) return;

    try {
      if (currentHighlight) {
        currentHighlight.clear();
        currentHighlight.add(range);
      } else {
        currentHighlight = new Highlight(range);
        CSS.highlights.set(HIGHLIGHT_NAME, currentHighlight);
      }
    } catch (e) {
      // Range may be invalid if DOM changed since we built ranges
      return;
    }

    scrollRangeIntoView(range);
  }

  function scrollRangeIntoView(range) {
    try {
      const rect = range.getBoundingClientRect();
      const inViewport = (rect.top >= -50 && rect.bottom <= window.innerHeight + 50);
      if (!inViewport) {
        const el = range.startContainer.parentElement;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    } catch (e) {
      // Range may be invalid
    }
  }

  // classList fallback path
  function highlightWithClassList(index) {
    const prev = document.querySelector('.' + FALLBACK_CLASS);
    if (prev) prev.classList.remove(FALLBACK_CLASS);

    const el = sentenceBlockMap[index];
    if (el) {
      el.classList.add(FALLBACK_CLASS);
      const rect = el.getBoundingClientRect();
      if (rect.top < -50 || rect.bottom > window.innerHeight + 50) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  // --- Auto-Advance (Timed Mode for AI Audio playback) ---
  // Distributes estimated duration across sentences proportionally by length.
  // Replaced by actual audio progress if HIGHLIGHT_PROGRESS events arrive.
  function startAutoAdvance(estimatedDurationMs) {
    stopAutoAdvance();
    if (sentences.length === 0 || estimatedDurationMs <= 0) return;

    const totalChars = sentences.reduce(function(sum, s) { return sum + s.text.length; }, 0);
    if (totalChars === 0) return;

    let currentIdx = 0;
    highlightSentence(0);

    function advance() {
      currentIdx++;
      if (currentIdx < sentences.length && isHighlightActive) {
        highlightSentence(currentIdx);
        var duration = (sentences[currentIdx].text.length / totalChars) * estimatedDurationMs;
        autoAdvanceTimer = setTimeout(advance, Math.max(duration, 100));
      }
    }

    var firstDuration = (sentences[0].text.length / totalChars) * estimatedDurationMs;
    autoAdvanceTimer = setTimeout(advance, Math.max(firstDuration, 100));
  }

  function stopAutoAdvance() {
    if (autoAdvanceTimer !== null) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
  }

  // --- Progress-based update (from actual audio position) ---
  // Maps a 0.0–1.0 fraction to the proportional sentence index.
  function updateFromProgress(fraction) {
    if (!isHighlightActive || sentences.length === 0) return;

    var totalChars = sentences.reduce(function(sum, s) { return sum + s.text.length; }, 0);
    var targetChar = fraction * totalChars;

    var accumulated = 0;
    for (var i = 0; i < sentences.length; i++) {
      accumulated += sentences[i].text.length;
      if (accumulated >= targetChar) {
        highlightSentence(i);
        return;
      }
    }
    highlightSentence(sentences.length - 1);
  }

  // --- Cleanup ---
  // Removes all highlight state. Safe to call multiple times.
  function cleanup() {
    stopWatchdog();
    stopAutoAdvance();

    // CSS Custom Highlight API cleanup
    if (hasHighlightAPI) {
      try { CSS.highlights.delete(HIGHLIGHT_NAME); } catch (e) { /* OK */ }
    }
    currentHighlight = null;

    // classList fallback cleanup
    var highlighted = document.querySelectorAll('.' + FALLBACK_CLASS);
    for (var i = 0; i < highlighted.length; i++) {
      highlighted[i].classList.remove(FALLBACK_CLASS);
    }

    if (document.body) {
      document.body.classList.remove(READING_CLASS);
    }

    sentences = [];
    sentenceRanges = [];
    sentenceBlockMap = [];
    activeSentenceIdx = -1;
    isHighlightActive = false;
  }

  // --- Public API ---
  return {
    /**
     * Start highlighting for the given text.
     * @param {string} text - The text being spoken
     * @param {object} [options]
     * @param {number} [options.estimatedDurationMs] - For timed auto-advance (AI audio)
     */
    start: function(text, options) {
      cleanup();
      if (!text || text.trim().length === 0) return;

      isHighlightActive = true;
      startWatchdog();
      sentences = splitIntoSentences(text);
      document.body.classList.add(READING_CLASS);

      if (hasHighlightAPI) {
        buildSentenceRanges();
      } else {
        mapSentencesToBlocks();
      }

      var mappedCount = hasHighlightAPI
        ? sentenceRanges.filter(function(r) { return r !== null; }).length
        : sentenceBlockMap.filter(function(b) { return b !== null; }).length;

      console.log('[GlowReadTTS] Highlight started:', sentences.length, 'sentences,',
        mappedCount, 'mapped,',
        hasHighlightAPI ? 'CSS Highlight API' : 'classList fallback');

      // Auto-advance for timed mode (AI audio playback)
      if (options && options.estimatedDurationMs) {
        startAutoAdvance(options.estimatedDurationMs);
      } else if (sentences.length > 0) {
        highlightSentence(0);
      }
    },

    /**
     * Update highlight based on TTS charIndex from boundary event (browser TTS).
     */
    updateCharIndex: function(charIndex) {
      if (!isHighlightActive) return;
      noteUpdate();
      var idx = getSentenceIndexForChar(charIndex);
      highlightSentence(idx);
    },

    /**
     * Update highlight based on actual audio position (AI audio playback).
     * Cancels timer-based advance and uses real progress instead.
     */
    updateProgress: function(currentTime, duration) {
      if (!isHighlightActive || duration <= 0) return;
      noteUpdate();
      stopAutoAdvance();
      updateFromProgress(currentTime / duration);
    },

    /**
     * Stop highlighting and clean up.
     */
    stop: function() {
      cleanup();
      console.log('[GlowReadTTS] Highlight stopped');
    },

    get active() {
      return isHighlightActive;
    }
  };
})();


// ============================================
// Message Handler
// ============================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Content Script] Message received:', request.action);

  switch (request.action) {
    case 'GET_SELECTED_TEXT': {
      const selectedText = window.getSelection().toString();
      sendResponse({ text: selectedText });
      break;
    }

    case 'GET_PAGE_TEXT': {
      const pageText = document.body ? document.body.innerText : '';
      sendResponse({ text: pageText });
      break;
    }

    // --- Highlight-as-you-read messages ---
    case 'START_HIGHLIGHT':
      GlowReadTTSHighlight.start(request.text, {
        estimatedDurationMs: request.estimatedDurationMs || 0
      });
      sendResponse({ success: true });
      break;

    case 'HIGHLIGHT_UPDATE':
      GlowReadTTSHighlight.updateCharIndex(request.charIndex);
      sendResponse({ success: true });
      break;

    case 'HIGHLIGHT_PROGRESS':
      GlowReadTTSHighlight.updateProgress(request.currentTime, request.duration);
      sendResponse({ success: true });
      break;

    case 'STOP_HIGHLIGHT':
      GlowReadTTSHighlight.stop();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false });
  }

  return true;
});

console.log('[GlowReadTTS] Content script ready');
