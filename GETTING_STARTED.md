# Getting Started with GlowReadTTS

GlowReadTTS reads webpages, PDFs, and text files aloud using your system's voices or downloadable on-device AI voices. The fastest way to try it is to highlight some text on a page, right-click, and choose **Read with GlowReadTTS**.

## Quick start

1. Highlight any text on a webpage.
2. Right-click on the selection.
3. Click **Read with GlowReadTTS**.

Audio starts; sentences highlight on the page as they're read. Click the toolbar icon and press **Stop** when you're done. The rest of this guide covers the other reading methods, voices, and settings.

## Installation

**From the Chrome Web Store:** open the GlowReadTTS listing, click *Add to Chrome*, accept the permission prompt. Pin the icon to your toolbar via the puzzle-piece menu if it doesn't appear automatically.

**From source:** clone the repo, open `chrome://extensions`, toggle *Developer mode*, click *Load unpacked*, and select the folder containing `manifest.json`.

Either way, an EULA tab opens automatically after install. Accept it before using any feature.

## First-time setup

The EULA tab shows the Terms of Use and Privacy Policy. Scroll to the bottom (the checkbox is disabled until you reach the end), tick the agreement box, click **Accept & Continue**. The tab closes and the extension is active.

If you click **Decline**, the extension stays installed but every feature is gated. Click the toolbar icon and **Review Terms** when you're ready to come back. Future material updates to the agreement may re-prompt; cosmetic changes won't.

## Reading text

There are five ways to feed text into the extension. Pick whichever fits your situation.

**Right-click selected text.** Highlight text, right-click, choose *Read with GlowReadTTS*. The fastest path; works without opening the popup. The menu item only appears when text is selected. It doesn't work on `chrome://`, the Chrome Web Store, the New Tab page, or other browser-internal pages - that's a Chrome security boundary, not a bug. If the EULA hasn't been accepted, the menu item opens the EULA tab instead of starting a read.

**Popup -> Selection button.** Same idea, but initiated from the popup. Useful when the right-click menu is awkward or being intercepted by another extension. Highlight text, click the toolbar icon, click **Selection**. The text appears in the popup textarea so you can confirm what's about to be read.

**Popup -> Full Page button.** Reads the main article content of the active tab. For news articles, blog posts, and other article-shaped pages, automatically extracts just the article body (skipping nav, sidebar, footer, ads, and cookie banners) using Mozilla's Readability library. For non-article pages (forums, web apps, search results), falls back to reading the full visible text. The textarea shows the first 5,000 characters of whichever was extracted; the full text is what gets spoken. The status briefly indicates "Reading article (Reader Mode)" or "Reading page" so you know which mode was used.

**Popup -> textarea + Read Text.** Type or paste any text into the textarea and click **Read Text**. The character count is gray under 2,000 characters, yellow at 2,000-5,000, red over 5,000 (some speech engines may cut off very long inputs). Hover the count for the explanation. The clipboard icon next to the textarea pastes from your clipboard; the trash icon clears it.

**Popup -> Upload button.** Loads a file from disk. Supports `.txt`, `.md`, `.json`, `.csv`, and `.pdf`. PDFs are extracted by a bundled parser; PDFs over 50,000 characters are truncated with a notice showing the original length, and image-only (scanned) PDFs return *no readable text*. Markdown, JSON, and CSV files are read as raw text - syntax characters get spoken too.

The popup also has a **Test Voice** button in the Quick Actions grid that reads a fixed test sentence using the currently selected voice and speed. Useful for auditioning AI voices once they're installed.

## Voices

**Browser / system voices** are already installed on your operating system. They're free, instant, and work offline. Quality varies by OS - macOS tends to have the best built-in voices, Linux the worst.

**AI voices** are 15 neural-network voices (American and British English) that run entirely on-device. They sound noticeably more natural than most system voices but require a one-time ~95MB download from huggingface.co. After download, they work offline.

To download AI voices:

1. Click the toolbar icon to open the popup.
2. Click **Download AI Voices (~95MB)** in the AI Voices card. Keep the popup open until the progress bar finishes - closing it cancels the download.
3. When done, the status row reads *Installed. Select an AI voice in the Voice dropdown below.* and the dropdown briefly outlines in green.
4. Open the Voice dropdown and pick one. The choice persists across popup opens and across your Chrome devices via Chrome sync.

Use system voices for short reads or on slow machines; use AI voices for long-form listening. Switch anytime from the Voice dropdown.

## Playback, speed, and highlights

When a read starts, the popup shows three controls: **Stop** (halts everything immediately), **Play/Pause** (the larger center button), and **Restart** (begins the same text from the top). Audio continues even if you close the popup - reopen and press Stop to halt. The popup's Stop button also halts AI right-click reads.

The **Speed slider** ranges from 0.25× to 2× in 0.25 increments, defaulting to 1×. Changing speed mid-read stops the current read; press the entry-point button again to restart at the new speed.

A translucent yellow **highlight** follows the spoken sentence on the page during right-click reads, Selection reads, and Full Page reads, and the page auto-scrolls to keep the active sentence in view. Highlighting doesn't apply to typed/pasted text, uploaded files, or the Test Voice button (the text isn't on the page). If the popup closes mid-read, a 60-second watchdog clears any orphaned highlight automatically.

## Settings

Open the settings page from the popup's gear icon, or via `chrome://extensions` -> Details -> Extension options.

Three things live there: **Default Voice** (system/browser voices only - AI voices are configured in the popup), **Default Speed** (same range as the popup's slider), and the **AI Voice Cache** controls, including a *Clear AI Voice Cache (~95MB)* button that prompts a confirmation before deleting. The About section shows version, author, and license.

## Privacy

GlowReadTTS doesn't collect any data, doesn't track you, and doesn't require an account. All text processing happens locally on your device - the text you read never leaves your computer. The only network call the extension makes is the one-time AI voice download from huggingface.co. After that, it works entirely offline. Permissions are used only when you explicitly trigger a read. See [PRIVACY.md](PRIVACY.md) for the full statement.

## Quick reference

| Task | How to do it |
|------|--------------|
| Read selected text (fastest) | Highlight, right-click, *Read with GlowReadTTS* |
| Read selected text (popup) | Highlight, toolbar icon, *Selection* |
| Read full page | Toolbar icon, *Full Page* |
| Read a file (`.txt`/`.md`/`.pdf` etc) | Toolbar icon, *Upload* |
| Read typed or pasted text | Toolbar icon, type or paste, *Read Text* |
| Test current voice | Toolbar icon, *Test Voice* |
| Download AI voices (one time) | Toolbar icon, *Download AI Voices (~95MB)* |
| Switch voices | Toolbar icon, Voice dropdown |
| Change speed | Toolbar icon, Speed slider (0.25× - 2×) |
| Pause / resume | Toolbar icon, center playback button |
| Stop everything | Toolbar icon, *Stop* |
| Open settings | Toolbar icon, gear icon |
| Clear AI cache | Settings, *Clear AI Voice Cache* |
| Re-accept the EULA | Toolbar icon, *Review Terms* |

## Troubleshooting

**Nothing happens when I click Read.** You're probably on a restricted page (`chrome://`, the Web Store, the New Tab page, internal browser views). Move to a regular webpage. For Selection or right-click flows, also confirm text is actually selected.

**Audio keeps playing after I close the popup.** Browser TTS is global to Chrome and continues across popup closes; AI right-click reads run in a separate document with the same property. Click the toolbar icon to reopen the popup, then **Stop**.

**The yellow highlight is stuck on the page.** Wait 60 seconds - the content-script watchdog clears it automatically. Or reload/navigate to clear it instantly. Or open the popup and press **Stop**.

**AI voices won't download.** Keep the popup open during the download (closing it cancels). Check your internet connection - the download fetches from huggingface.co. If it fails partway, click *Download AI Voices* again to retry.

**PDF says "no readable text".** The PDF is image-only (scanned). The extension can't OCR images. Use a separate OCR tool to convert it first, or paste the text into the popup textarea instead.

**My selected voice keeps changing on its own.** This happens once, after a version upgrade where your previous AI voice was retired. The extension migrates you to *Heart* and shows a notice in the AI Voices status row. Pick a different voice from the dropdown if you'd prefer; the new selection persists.

**Test Voice says "browser voice" when I picked an AI voice.** Reload the extension via `chrome://extensions` (toggle off/on, or click the refresh icon). You're on an outdated build; the latest version branches the Test Voice copy on whether an AI or browser voice is active.

**Audio sounds choppy or distorted.** Most often this is CPU load (close other tabs/apps) or extreme speed settings - 0.25× and 2× can introduce artifacts depending on the voice. The 0.75×-1.75× range is generally cleanest. For browser voices, switching to a different system voice can also help.

## Where to get help

- [GitHub issues](https://github.com/lavellehatcherjr/GlowReadTTS/issues)
- [Privacy Policy](PRIVACY.md)
- [Terms of Use](EULA.md)
- [License](LICENSE) (Apache 2.0)
- [Third-party notices](NOTICE)
