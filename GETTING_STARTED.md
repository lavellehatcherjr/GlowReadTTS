# Getting Started with GlowReadTTS

GlowReadTTS reads selected webpage text and pasted/typed text aloud using bundled on-device AI voices. The fastest way to try it is to highlight some text on a page, right-click, and choose **Read with GlowReadTTS**.

## Quick start

1. Highlight any text on a webpage.
2. Right-click on the selection.
3. Click **Read with GlowReadTTS**.

Audio starts; sentences highlight on the page as they're read. Click the toolbar icon and press **Stop** when you're done. The rest of this guide covers the popup-driven reading method, voices, and settings.

## Installation

**From the Chrome Web Store:** open the GlowReadTTS listing, click *Add to Chrome*, accept the permission prompt. Pin the icon to your toolbar via the puzzle-piece menu if it doesn't appear automatically.

**From source:** clone the repo, open `chrome://extensions`, toggle *Developer mode*, click *Load unpacked*, and select the folder containing `manifest.json`.

Either way, an EULA tab opens automatically after install. Accept it before using any feature.

## First-time setup

The EULA tab shows the Terms of Use and Privacy Policy. Scroll to the bottom (the checkbox is disabled until you reach the end), tick the agreement box, click **Accept & Continue**. The tab closes and the extension is active.

If you click **Decline**, the extension stays installed but every feature is gated. Click the toolbar icon and **Review Terms** when you're ready to come back. Future material updates to the agreement may re-prompt; cosmetic changes won't.

## Reading text

There are two ways to feed text into the extension. Pick whichever fits your situation.

**Right-click selected text.** Highlight text, right-click, choose *Read with GlowReadTTS*. The fastest path; works without opening the popup. The menu item only appears when text is selected. It doesn't work on `chrome://`, the Chrome Web Store, the New Tab page, or other browser-internal pages - that's a Chrome security boundary, not a bug. If the EULA hasn't been accepted, the menu item opens the EULA tab instead of starting a read.

**Popup -> textarea + Read Text.** Type or paste any text into the textarea and click **Read Text**. The character count is gray under 2,000 characters, yellow at 2,000–5,000, red over 5,000 (very long inputs may take noticeably longer to start). Hover the count for the explanation. The trash icon next to the textarea clears it. The question-mark icon opens this getting-started guide.

The popup's **Quick Actions** grid has three buttons: **Help** (opens this getting-started guide in a new tab), **Test Voice** (reads a fixed test sentence using the currently selected voice and speed - useful for auditioning voices), and **Settings**.

## Voices

GlowReadTTS ships with 15 neural-network voices (American and British English) that run entirely on-device. They're bundled inside the extension package - nothing to download, nothing to install, no network calls. Open the Voice dropdown in the popup and pick one. The choice persists across popup opens and across your Chrome devices via Chrome sync.

Inference streams sentence-by-sentence: audio starts within ~1–2 seconds of clicking Read on capable hardware (after the first read of a session), and the rest of the paragraph generates in the background while the first sentence plays.

## Playback, speed, and highlights

When a read starts, the popup shows three controls: **Stop** (halts everything immediately), **Play/Pause** (the larger center button), and **Restart** (begins the same text from the top). Audio continues even if you close the popup - reopen and press Stop to halt. The popup's Stop button also halts right-click reads.

The **Speed slider** ranges from 0.25× to 2× in 0.25 increments, defaulting to 1×. Changing speed mid-read stops the current read; press the entry-point button again to restart at the new speed.

A translucent yellow **highlight** follows the spoken sentence on the page during right-click reads, and the page auto-scrolls to keep the active sentence in view. Highlighting doesn't apply to typed/pasted text or the Test Voice button (the text isn't on the page). If the popup closes mid-read, a 60-second watchdog clears any orphaned highlight automatically.

## Settings

Open the settings page from the popup's gear icon, or via `chrome://extensions` -> Details -> Extension options.

Three things live there: **Default Voice**, **Default Speed** (same range as the popup's slider), and a **Performance** toggle. The About section shows version, author, and license.

**Performance - Pre-warm AI voice on selection.** Defaults to ON. When enabled, the AI model starts loading into RAM the moment you highlight text on a page, so the first right-click read of a session starts in ~1–2 s instead of paying the full ~3–6 s cold-load. Turn it OFF if you'd rather minimize background CPU and let the model load only when you actually click Read - the first read of a session will be slower, but the extension stays at minimal RAM until you invoke it. This setting is stored locally on your device only; it never syncs across browsers.

## Privacy

GlowReadTTS doesn't collect any data, doesn't track you, and doesn't require an account. All text processing happens locally on your device - the text you read never leaves your computer. The extension makes NO network calls during normal operation: the AI voices ship inside the package, inference runs in WebAssembly on your CPU, and audio plays from a local offscreen document. Permissions are used only when you explicitly trigger a read. See [PRIVACY.md](PRIVACY.md) for the full statement.

## Quick reference

| Task | How to do it |
|------|--------------|
| Read selected text | Highlight, right-click, *Read with GlowReadTTS* |
| Read typed or pasted text | Toolbar icon, type or paste, *Read Text* |
| Open this help guide | Toolbar icon, *Help* (Quick Actions) |
| Test current voice | Toolbar icon, *Test Voice* |
| Switch voices | Toolbar icon, Voice dropdown |
| Change speed | Toolbar icon, Speed slider (0.25× - 2×) |
| Pause / resume | Toolbar icon, center playback button |
| Stop everything | Toolbar icon, *Stop* |
| Open settings | Toolbar icon, gear icon |
| Re-accept the EULA | Toolbar icon, *Review Terms* |

## Troubleshooting

**Nothing happens when I click Read.** You're probably on a restricted page (`chrome://`, the Web Store, the New Tab page, internal browser views). Move to a regular webpage. For the right-click flow, also confirm text is actually selected.

**Audio keeps playing after I close the popup.** Audio runs in a separate offscreen document so it survives popup close. Click the toolbar icon to reopen the popup, then **Stop**.

**The yellow highlight is stuck on the page.** Wait 60 seconds - the content-script watchdog clears it automatically. Or reload/navigate to clear it instantly. Or open the popup and press **Stop**.

**My selected voice keeps changing on its own.** This happens once when your previously-saved voice is no longer available. Reasons: (1) you had a system / browser voice saved from before the AI-only migration; (2) a version upgrade retired the specific AI voice you had selected. Either way, the extension falls back to the default (`af_heart`) and persists the new choice. Pick a different voice from the dropdown if you'd prefer; the new selection sticks.

**Audio sounds choppy or distorted.** Most often this is CPU load (close other tabs/apps) or extreme speed settings - 0.25× and 2× can introduce artifacts depending on the voice. The 0.75×–1.75× range is generally cleanest.

**The first read of a session takes a long time before audio starts.** With the *Performance → Pre-warm AI voice on selection* toggle ON (the default), the 92 MB neural model starts loading the moment you highlight text on a page, so your first right-click read usually starts in ~1–2 seconds. If you've turned the toggle OFF, the model only loads when you explicitly trigger a read - so the first right-click / Read Text / Test Voice in a browser session pays a one-time ~3–6 second cold-load (longer on slower CPUs). Either way, every read after the first in the same session starts within ~1–2 seconds.

## Where to get help

- [GitHub issues](https://github.com/lavellehatcherjr/GlowReadTTS/issues)
- [Privacy Policy](PRIVACY.md)
- [Terms of Use](EULA.md)
- [License](LICENSE) (Apache 2.0)
- [Third-party notices](NOTICE)
