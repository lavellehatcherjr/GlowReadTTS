<p align="center">
  <img src="assets/icon-256.png" alt="GlowReadTTS" width="200" height="200">
</p>

# GlowReadTTS

A Chrome extension that reads webpages, PDFs, and text files aloud using your browser's built-in TTS voices or downloadable on-device AI voices. Fully offline-capable, with no accounts, API keys, or data collection.

### On-Device AI Voices. Highlight as You Read.

---

## Features

- **Browser TTS Voices** - Use your system's built-in text-to-speech voices, completely free and offline
- **AI Voices** - Download once (~95MB), use forever. Natural-sounding offline AI voices, no API keys needed
- **Text Input** - Paste or type any text and hear it read aloud
- **Selection Reading** - Highlight text on any webpage and read it aloud with highlight-as-you-read
- **Full Page Reading** - Read an entire webpage aloud with sentence-by-sentence highlighting
- **PDF Support** - Upload a PDF and extract text for reading aloud
- **File Upload** - Upload .txt, .md, .json, or .csv files to read aloud
- **Right-Click Menu** - Select text, right-click, choose "Read with GlowReadTTS"
- **Speed Control** - Adjust reading speed from 0.25x to 4x
- **Voice Selection** - Choose from browser voices or downloaded AI voices
- **Privacy First** - All processing happens locally. No data collection. No analytics. No accounts.
- **Offline Mode** - Browser TTS and AI voices both work without internet

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable "Developer mode" (top right toggle)
4. Click "Load unpacked"
5. Select the repository folder
6. Click the GlowReadTTS icon in your toolbar to start

## Usage

1. **Type or paste text** into the text box and click "Read Text"
2. **Select text** on any page → click the GlowReadTTS icon → click "Selection"
3. **Read a full page** → click the icon → click "Full Page"
4. **Upload a file** → click "Upload" → choose a .txt, .pdf, or other supported file
5. **Right-click** selected text → "Read with GlowReadTTS"

## AI Voices

GlowReadTTS includes optional AI-powered voices that run entirely on your device. These voices:

- Sound significantly more natural than browser TTS
- Download from Hugging Face on first use (~95MB), then run entirely offline
- Require no API keys, accounts, or ongoing costs
- Supports American and British English with 15 curated AI voices
- Available from the popup and from the right-click context menu (previously the right-click flow fell back to system voice)

To enable: open GlowReadTTS → click "Download AI Voices" → wait for download → select an AI voice from the dropdown.

## Privacy & Security

- **Zero data collection** - no analytics, no telemetry, no tracking
- **100% local processing** - text never leaves your device
- **No accounts** - no sign-up, no API keys required
- **Open source** - full transparency, inspect the code yourself

## Tech Stack

- Vanilla JavaScript (no frameworks, no build step)
- Chrome Extension Manifest V3

For the full list of third-party libraries and their licenses, see [NOTICE](NOTICE).

## License

Apache License 2.0 - see [LICENSE](LICENSE) and [NOTICE](NOTICE) files.
