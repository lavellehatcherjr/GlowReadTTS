/**
 * GlowReadTTS Content Script
 * Handles highlight-as-you-read for right-click reads (and any popup-driven
 * read whose text is also visible on the active tab).
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

  // Forward-only walk pointer for sentence-boundary matches. Tracked
  // separately from activeSentenceIdx because the matched index can lag
  // the displayed one when chunks span multiple page sentences.
  let lastMatchedSentenceIdx = -1;

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
  // Splits text into sentences. Handles ., !, ? followed by whitespace,
  // and paragraph breaks. Returns [{ text }] entries.
  function splitIntoSentences(text) {
    const result = [];
    let current = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      current += char;

      const isEndPunct = (char === '.' || char === '!' || char === '?');
      const nextIsSpaceOrEnd = (i === text.length - 1 || /\s/.test(text[i + 1]));
      const isParaBreak = (char === '\n' && i + 1 < text.length && text[i + 1] === '\n');

      if ((isEndPunct && nextIsSpaceOrEnd) || isParaBreak) {
        const trimmed = current.trim();
        if (trimmed.length > 0) result.push({ text: trimmed });
        while (i + 1 < text.length && /\s/.test(text[i + 1])) { i++; }
        current = '';
      }
    }

    const remaining = current.trim();
    if (remaining.length > 0) result.push({ text: remaining });

    return result;
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

    // A sentence usually spans several text nodes, so start and end are resolved
    // independently in one pass. The comparisons are deliberately asymmetric:
    // rawEnd is exclusive, so it may land exactly on a node's rawEnd.
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

    // Null means this sentence goes unhighlighted; the read continues either way.
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
      // One or two characters would match almost anywhere; don't guess.
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
      // Advance past this match so a sentence repeated on the page maps to its
      // next occurrence rather than every copy collapsing onto the first.
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

  // --- Chunk-boundary update (from worker SENTENCE_START signal) ---
  // The worker tells us exactly which Kokoro sentence's audio just started.
  // The Kokoro segmenter handles abbreviations / decimals / URLs better than
  // our simple punctuation split, so chunk text doesn't always match a page
  // sentence one-to-one. Strategy:
  //   1. Forward-only search from lastMatchedSentenceIdx+1, accept the first
  //      sentence that overlaps the chunk text by either substring direction.
  //   2. If no forward match is found, advance by ONE page sentence anyway
  //      (a heuristic for abbreviation / decimal / quoted-speech mismatches).
  //      This keeps the highlight progressing in lock-step with chunk
  //      transitions even when Kokoro's segmenter disagrees with our regex
  //      about boundaries.
  // Chunk transitions are the only highlight driver; the prior char-based
  // fallback overshot the audio because the duration estimate used by
  // `currentTime / duration` underestimated Kokoro's real speaking rate.
  function normalizeForMatch(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function applySentenceStartText(chunkText) {
    if (!isHighlightActive || sentences.length === 0) return;
    var normChunk = normalizeForMatch(chunkText);
    if (!normChunk) return;
    noteUpdate();
    var startIdx = lastMatchedSentenceIdx + 1;
    if (startIdx < 0) startIdx = 0;
    for (var i = startIdx; i < sentences.length; i++) {
      var normPage = normalizeForMatch(sentences[i].text);
      if (!normPage) continue;
      if (normPage === normChunk ||
          normPage.indexOf(normChunk) !== -1 ||
          normChunk.indexOf(normPage) !== -1) {
        lastMatchedSentenceIdx = i;
        highlightSentence(i);
        return;
      }
    }
    // No forward substring match. Advance by one page sentence so the
    // highlight doesn't strand on the previous match while audio keeps
    // moving. highlightSentence is bounds-checked so this is safe even
    // when chunk-count > sentence-count.
    if (startIdx < sentences.length) {
      lastMatchedSentenceIdx = startIdx;
      highlightSentence(startIdx);
    }
  }

  // --- Cleanup ---
  // Removes all highlight state. Safe to call multiple times.
  function cleanup() {
    stopWatchdog();

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
    lastMatchedSentenceIdx = -1;
  }

  // --- Public API ---
  return {
    /**
     * Start highlighting for the given text.
     * @param {string} text - The text being spoken
     */
    start: function(text) {
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

      if (sentences.length > 0) highlightSentence(0);
    },

    /**
     * Watchdog tap. Refreshes lastUpdateAt so the 60s no-update cleanup
     * doesn't trip during long single-sentence reads where applySentenceStart
     * fires only once at chunk-0 transition. Does NOT advance the highlight.
     */
    updateProgress: function() {
      if (!isHighlightActive) return;
      noteUpdate();
    },

    /**
     * Update highlight when the audio for a Kokoro chunk just started.
     * The chunk text is matched against the page's sentence list; this is
     * the sole driver of highlight advancement.
     */
    applySentenceStart: function(chunkText) {
      applySentenceStartText(chunkText);
    },

    /**
     * Stop highlighting and clean up.
     */
    stop: function() {
      cleanup();
      console.log('[GlowReadTTS] Highlight stopped');
    }
  };
})();


// ============================================
// Visible-only selection extraction
// ============================================
// Chrome's `info.selectionText` (right-click context) includes hidden DOM
// content that's part of the user's selected range — most commonly screen-
// reader-only nodes (.sr-only, .visually-hidden, etc.) using off-screen
// positioning or clip-path. The user can't see them, but they end up in
// the audio anyway, which makes the read sound like it's starting in the
// wrong place. Extracting the selection ourselves with visibility filtering
// avoids this.
//
// Walks the user's current selection range with a TreeWalker, dropping any
// text node whose ancestor chain has display:none / visibility:hidden /
// opacity:0 / clip:rect(0,0,0,0) / clip-path:inset(50% or 100%) / 1×1 sized
// (the canonical sr-only patterns), or is positioned entirely off-screen.
function isAncestorChainVisible(el) {
  let cur = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    let cs;
    try { cs = getComputedStyle(cur); } catch (e) { return true; }
    if (!cs) return true;
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    const clip = cs.clip || '';
    if (clip === 'rect(0px, 0px, 0px, 0px)' || clip === 'rect(1px, 1px, 1px, 1px)') return false;
    const cp = cs.clipPath || '';
    if (cp === 'inset(50%)' || cp === 'inset(100%)') return false;
    try {
      const rect = cur.getBoundingClientRect();
      if (rect.width <= 1 && rect.height <= 1 && cs.overflow === 'hidden') return false;
    } catch (e) { /* getBoundingClientRect can throw on detached nodes */ }
    cur = cur.parentElement;
  }
  return true;
}

// Block-level tags. When two consecutive text nodes in the user's
// selection live under different block ancestors (heading→paragraph,
// paragraph→list-item, list-item→list-item, etc.), we treat that as a
// structural boundary and ensure the prior text fragment ends with
// terminal punctuation. This makes Kokoro's TextSplitterStream produce
// a real chunk break at that boundary — which gets the SAME natural
// inter-chunk pause as a normal sentence end (~10–50 ms perceptual,
// shaped by our silence trim + 5 ms chunk overlap). NOT a long
// dramatic pause; just the normal sentence-rhythm pause Kokoro gives
// between any two periods.
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'DT', 'DD',
  'FIGCAPTION', 'CAPTION', 'SUMMARY',
  'ARTICLE', 'SECTION', 'HEADER', 'FOOTER',
  'ASIDE', 'MAIN', 'NAV', 'DETAILS'
]);

function closestBlockAncestor(el) {
  let cur = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function extractVisibleSelectionText(range) {
  const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!root) return '';

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isAncestorChainVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const pieces = [];
  let prevBlock = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let text = node.textContent || '';
    const isStart = node === range.startContainer;
    const isEnd = node === range.endContainer;
    if (isStart && isEnd) {
      text = text.substring(range.startOffset, range.endOffset);
    } else if (isStart) {
      text = text.substring(range.startOffset);
    } else if (isEnd) {
      text = text.substring(0, range.endOffset);
    }
    if (text.length === 0) continue;

    // Block-boundary detection. If this text node lives in a different
    // block-level ancestor than the previous one, ensure the previous
    // piece ends with sentence-terminating punctuation. Kokoro's
    // segmenter splits on . ! ? — adding one here turns
    // "Heading Body" into "Heading. Body" which becomes two chunks
    // with the same normal inter-chunk pause as any other sentence
    // boundary. Trailing closing-quote / closing-paren is allowed
    // (e.g., `Hello."` already counts as ending in a period).
    const block = closestBlockAncestor(node.parentElement);
    if (block !== prevBlock && pieces.length > 0) {
      const last = pieces[pieces.length - 1];
      const trimmedLast = last.replace(/\s+$/, '');
      if (trimmedLast.length > 0 && !/[.!?][)"'’”»\]]?$/.test(trimmedLast)) {
        pieces[pieces.length - 1] = trimmedLast + '.';
      }
    }

    pieces.push(text);
    prevBlock = block;
  }
  // Single-space between text-node fragments; collapse runs of whitespace
  // (the browser would have rendered them as single spaces anyway).
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}


// ============================================
// Cold-load indicator (loading pill)
// ============================================
// On the very first right-click read of a browser session, the worker has
// to load the 92 MB Kokoro model + voice embedding + JIT-compile WASM
// kernels (~3–6 s on warm CPUs, longer on cold ones). Without a visible
// indicator the user is left wondering whether the click registered.
//
// Strategy: schedule the pill 800 ms after START_HIGHLIGHT arrives. If
// audio actually starts within that window (warm read), the SENTENCE_START
// handler hides it before it ever appears — so the pill is silent on
// fast reads and only appears when the user is in the cold path.
let glowreadttsLoadingPill = null;
let glowreadttsLoadingPillTimer = null;
let glowreadttsLoadingPillAutoHide = null;
const GLOWREADTTS_PILL_DELAY_MS = 800;
const GLOWREADTTS_PILL_AUTOHIDE_MS = 30000;

function scheduleLoadingPill() {
  hideLoadingPill();
  glowreadttsLoadingPillTimer = setTimeout(() => {
    glowreadttsLoadingPillTimer = null;
    showLoadingPill();
  }, GLOWREADTTS_PILL_DELAY_MS);
}

function showLoadingPill() {
  if (glowreadttsLoadingPill) return;
  if (!document.body) return;
  const pill = document.createElement('div');
  pill.className = 'glowreadtts-loading-pill';
  const spinner = document.createElement('div');
  spinner.className = 'glowreadtts-loading-spinner';
  const text = document.createElement('span');
  text.textContent = 'Loading AI voice…';
  pill.appendChild(spinner);
  pill.appendChild(text);
  document.body.appendChild(pill);
  // Force reflow so the opacity transition runs.
  void pill.offsetWidth;
  pill.classList.add('glowreadtts-visible');
  glowreadttsLoadingPill = pill;
  // Failsafe: if SENTENCE_START never arrives (worker error, network
  // wedge, etc.), drop the pill on its own after 30 s.
  glowreadttsLoadingPillAutoHide = setTimeout(hideLoadingPill, GLOWREADTTS_PILL_AUTOHIDE_MS);
}

function hideLoadingPill() {
  if (glowreadttsLoadingPillTimer !== null) {
    clearTimeout(glowreadttsLoadingPillTimer);
    glowreadttsLoadingPillTimer = null;
  }
  if (glowreadttsLoadingPillAutoHide !== null) {
    clearTimeout(glowreadttsLoadingPillAutoHide);
    glowreadttsLoadingPillAutoHide = null;
  }
  if (glowreadttsLoadingPill) {
    const pill = glowreadttsLoadingPill;
    glowreadttsLoadingPill = null;
    pill.classList.remove('glowreadtts-visible');
    // 250 covers the 200ms opacity transition on .glowreadtts-loading-pill in
    // content.css, plus buffer. Lengthen that transition and the pill is
    // removed mid-fade. hideStopButton() carries the same coupling.
    setTimeout(() => { try { pill.remove(); } catch (e) { /* ignore */ } }, 250);
  }
}


// ============================================
// On-page Stop button
// ============================================
// Floating top-right button that appears the moment audio starts on a
// right-click read and disappears when the read ends or the user clicks
// it. Same design language as the loading pill, but interactive
// (pointer-events: auto). Click forwards STOP_FROM_PAGE to the SW which
// relays OFFSCREEN_STOP to the offscreen — same code path as the popup's
// Stop button. Idempotent: showStopButton() is a no-op if the button
// already exists, so SENTENCE_START firing once per chunk doesn't
// re-create it.
let glowreadttsStopButton = null;

function showStopButton() {
  if (glowreadttsStopButton) return;
  if (!document.body) return;

  const btn = document.createElement('button');
  btn.className = 'glowreadtts-stop-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Stop GlowReadTTS reading');

  // SVG icon — built via DOM API (no innerHTML) for CSP safety.
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'glowreadtts-stop-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(svgNS, 'rect');
  rect.setAttribute('x', '6');
  rect.setAttribute('y', '6');
  rect.setAttribute('width', '12');
  rect.setAttribute('height', '12');
  rect.setAttribute('rx', '2');
  svg.appendChild(rect);
  btn.appendChild(svg);

  const label = document.createElement('span');
  label.textContent = 'Stop';
  btn.appendChild(label);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      chrome.runtime.sendMessage(
        { target: 'service-worker', action: 'STOP_FROM_PAGE' },
        () => { void chrome.runtime.lastError; }
      );
    } catch (err) { /* SW unavailable; UI still responds */ }
    // Hide immediately for responsiveness — the SW's STOP_HIGHLIGHT
    // broadcast will arrive shortly after as a confirmation, and the
    // STOP_HIGHLIGHT handler is idempotent against an already-hidden
    // button.
    hideStopButton();
  });

  document.body.appendChild(btn);
  // Force reflow so the opacity transition runs.
  void btn.offsetWidth;
  btn.classList.add('glowreadtts-visible');
  glowreadttsStopButton = btn;
}

function hideStopButton() {
  if (glowreadttsStopButton) {
    const btn = glowreadttsStopButton;
    glowreadttsStopButton = null;
    btn.classList.remove('glowreadtts-visible');
    // 250 covers the 200ms opacity transition on .glowreadtts-stop-btn in
    // content.css, plus buffer. Same coupling as hideLoadingPill().
    setTimeout(() => { try { btn.remove(); } catch (e) { /* ignore */ } }, 250);
  }
}


// ============================================
// Message Handler
// ============================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Content Script] Message received:', request.action);

  switch (request.action) {
    // PING is the SW's "is the content script loaded?" probe used by
    // ensureContentScript before it falls back to scripting.executeScript.
    // Replying with anything truthy is enough.
    case 'PING':
      sendResponse({ success: true });
      break;

    // SW asks the page for visibility-filtered selection text before
    // dispatching a right-click read. Filters out hidden screen-reader-
    // only / off-screen / clipped nodes that Chrome's `info.selectionText`
    // would otherwise include. SW falls back to info.selectionText if
    // we don't reply within ~200 ms or return an empty string.
    case 'GET_VISIBLE_SELECTION': {
      let visibleText = '';
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          visibleText = extractVisibleSelectionText(sel.getRangeAt(0));
        }
      } catch (e) { /* fall through with empty text */ }
      sendResponse({ text: visibleText });
      break;
    }

    // --- Highlight-as-you-read messages ---
    case 'START_HIGHLIGHT':
      GlowReadTTSHighlight.start(request.text);
      // Schedule the cold-load pill. It only shows if audio hasn't
      // started by GLOWREADTTS_PILL_DELAY_MS — the SENTENCE_START
      // handler below cancels it on the warm path.
      scheduleLoadingPill();
      sendResponse({ success: true });
      break;

    case 'HIGHLIGHT_PROGRESS':
      GlowReadTTSHighlight.updateProgress();
      sendResponse({ success: true });
      break;

    case 'SENTENCE_START':
      GlowReadTTSHighlight.applySentenceStart(request.text);
      // First chunk's audio just started — kill any pending or visible
      // cold-load pill since the user is no longer "waiting."
      hideLoadingPill();
      // ...and surface the on-page Stop button so the user can halt
      // the read without opening the popup. Idempotent — only creates
      // the button on the first SENTENCE_START of a read.
      showStopButton();
      sendResponse({ success: true });
      break;

    case 'STOP_HIGHLIGHT':
      GlowReadTTSHighlight.stop();
      hideLoadingPill();
      hideStopButton();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false });
  }

  return true;
});


// ============================================
// Selection-driven prewarm (gated on a user setting)
// ============================================
// When the user selects non-trivial text on a page, ping the service
// worker to start loading the AI voice model in the background. By the
// time they open the right-click menu and choose "Read with GlowReadTTS",
// the worker is warm and click-to-audio drops from ~3-6 s (cold) to
// ~1-2 s (warm).
//
// Gated on the `prewarmOnSelection` setting (chrome.storage.local — local
// to this device only, never syncs). Off = extension stays ~5-10 MB
// until the user explicitly invokes a read. Setting is cached here and
// updated live via chrome.storage.onChanged so a toggle change in the
// options page takes effect immediately across all tabs.
//
// Latency optimizations vs. the previous implementation:
//   - No debounce: fires on the FIRST selectionchange that has >=5 chars,
//     so prewarm starts ~500 ms sooner on fast-clicking flows.
//   - One-shot per page: prewarmedThisDocument flag prevents re-fire
//     during drag-select / extension. The SW's prewarm is idempotent
//     anyway, so even if the flag failed we'd just have extra cheap
//     no-op pings.
//   - Also listens for mouseup + keyup so selections finalized via
//     mouse release or keyboard (shift+arrow / ctrl+a) trigger
//     immediately, not just on the synthetic selectionchange.
(function setupSelectionPrewarm() {
  // Default to true — matches the SW-side default in onInstalled. If
  // chrome.storage isn't yet readable on the very first frame (rare),
  // we'd prewarm on the first selection rather than miss it.
  let prewarmEnabled = true;
  let prewarmedThisDocument = false;
  const MIN_CHARS = 5;

  try {
    chrome.storage.local.get('prewarmOnSelection').then((r) => {
      if (typeof r.prewarmOnSelection === 'boolean') {
        prewarmEnabled = r.prewarmOnSelection;
      }
    }).catch(() => { /* ignore */ });
  } catch (e) { /* chrome.storage may be unavailable; use the default */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes.prewarmOnSelection) return;
      const next = changes.prewarmOnSelection.newValue;
      prewarmEnabled = (next !== false);
    });
  } catch (e) { /* listener may be unavailable; setting is sticky to startup value */ }

  function tryPrewarm() {
    if (!prewarmEnabled) return;
    if (prewarmedThisDocument) return;
    let text = '';
    try {
      const sel = window.getSelection();
      text = sel ? sel.toString() : '';
    } catch (e) { return; }
    if (text.length < MIN_CHARS) return;
    prewarmedThisDocument = true;
    try {
      chrome.runtime.sendMessage(
        { target: 'service-worker', action: 'WARM_AI_VOICE' },
        function () { void chrome.runtime.lastError; }
      );
    } catch (e) {
      // SW may be torn down between callers. Reset so the next event
      // can retry. (The dedupe at the SW level still prevents redundant
      // model loads.)
      prewarmedThisDocument = false;
    }
  }

  // selectionchange covers programmatic + drag-select. mouseup catches
  // the moment a drag-select finishes. keyup catches keyboard selection
  // (shift+arrow, ctrl+a). All three converge on the one-shot tryPrewarm.
  document.addEventListener('selectionchange', tryPrewarm, { passive: true });
  document.addEventListener('mouseup', tryPrewarm, { passive: true });
  document.addEventListener('keyup', tryPrewarm, { passive: true });
})();

console.log('[GlowReadTTS] Content script ready');
