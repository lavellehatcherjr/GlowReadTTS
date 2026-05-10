> **Source.** This file is a mirror of the Privacy Policy displayed within the GlowReadTTS browser extension at first run. The canonical text is the version users accept inside the extension. This Markdown copy exists for external reference and Chrome Web Store submission.

# Privacy Policy

**Last Updated:** May 10, 2026

Lavelle Hatcher Jr ("Developer," "we," "us," or "our") operates the GlowReadTTS browser extension ("Software"). This Privacy Policy describes how we handle information when you use the Software. By using the Software, you agree to the practices described in this Privacy Policy.

## Section 1: Information We Do Not Collect

**1.1** We do not collect, store, transmit, sell, rent, lease, or process any personal information or personally identifiable information (PII). Specifically:

- **(a)** We do not collect your name, email address, phone number, mailing address, or any identifying information.
- **(b)** We do not collect, transmit, or store any text you process through the Software, including text you type, paste, or select on a webpage.
- **(c)** We do not collect browsing history, URLs visited, webpage content, or any browsing activity data.
- **(d)** We do not use cookies, web beacons, analytics services, tracking pixels, fingerprinting, or any tracking technology.
- **(e)** We do not collect device identifiers, hardware information, IP addresses, geolocation data, or operating system information.
- **(f)** We do not sell, share, rent, lease, or transfer any user data to any third party for any purpose, including advertising, marketing, data brokerage, or analytics.
- **(g)** We do not collect biometric data, voice data, or any other sensitive personal information.
- **(h)** We do not collect or process data about children or minors.

## Section 2: Local Data Processing

**2.1** All text-to-speech processing occurs entirely and exclusively on your local device:

- **(a)** AI Voice Synthesis: Text is processed by a neural network model (Kokoro-82M ONNX) running locally on your device via WebAssembly (ONNX Runtime Web). The model weights and voice embeddings are bundled inside the extension package. No text is transmitted to any external server for voice synthesis.

**2.2** The Software has no backend servers, no cloud infrastructure, no databases, and no server-side code. There is no server to which data could be transmitted.

## Section 3: Data Stored Locally on Your Device

**3.1** The Software stores the following data locally using Chrome's built-in storage APIs. All data listed below is stored exclusively on your device and is automatically and permanently deleted when the Software is uninstalled:

- **(a)** Voice and speed preferences (`chrome.storage.sync`) - synced across your Chrome devices if Chrome sync is enabled (this is a Chrome feature, not controlled by the Software).
- **(b)** EULA/Privacy Policy acceptance state (`chrome.storage.local`) - records that you accepted these terms, the version accepted, and the date of acceptance.
- **(c)** Selection-prewarm preference (`chrome.storage.local`) - a single boolean (`prewarmOnSelection`) that controls whether the AI voice model preloads when you select text on a page. Stored only on this device - never syncs to any server.
- **(d)** Session text for playback continuity (`sessionStorage`) - temporarily stores the most recently read text. This is automatically cleared when the popup is closed.
- **(e)** Transient playback state flag (`chrome.storage.session`) - a single boolean (`playbackActive`) used internally to surface a "Reading in progress" banner when the popup reopens during an active read. Cleared when audio ends or is stopped, and automatically cleared on browser restart. Contains no user content or identifying information.

**3.2** No data stored by the Software is accessible to other extensions, websites, or applications. Chrome's storage APIs are sandboxed to the extension's unique origin.

## Section 4: Network Requests

**4.1** The Software makes NO network requests during normal operation. All processing - including AI voice synthesis using the bundled Kokoro neural network - happens locally on your device.

**4.2** The AI voice model and voice embeddings are bundled inside the extension package at install time. No runtime download from huggingface.co or any other server is required.

**4.3** The Software does not contact any analytics services, advertising networks, crash reporting services, update servers, or any other external endpoints.

## Section 5: Permissions Justification

**5.1** The Software requests the following Chrome browser permissions. Each permission is used solely for the purpose described below:

- **(a)** "storage" - to save your voice and speed preferences locally on your device.
- **(b)** "activeTab" - to read selected text from the currently active browser tab when you explicitly request a right-click read via the "Read with GlowReadTTS" menu item.
- **(c)** "contextMenus" - to add the "Read with GlowReadTTS" option to the right-click context menu.
- **(d)** "notifications" - to surface a brief "Preparing audio…" toast on the first AI read of a session.
- **(e)** "offscreen" - to host the audio playback element and the on-device neural inference Web Worker in a document that survives popup close.
- **(f)** "scripting" - to inject the highlight-as-you-read content script on tabs that don't already have it loaded (e.g., tabs that were open before the Software was installed or reloaded).
- **(g)** "<all_urls>" host permission - required for the content script to operate on any webpage the user visits, so that the right-click "Read with GlowReadTTS" action and its highlight-as-you-read functionality work on all websites. This permission does NOT grant the Software automatic access to page content; selected text is only accessed when the user explicitly triggers a reading action via the right-click menu.

**5.2** No permission is used to monitor, collect, log, or transmit browsing activity, page content, user data, or any other information.

## Section 6: Third-Party Services

**6.1** Google Chrome APIs: The Software uses Chrome's built-in APIs (`chrome.storage`, `chrome.contextMenus`, `chrome.scripting`, `chrome.offscreen`, `chrome.notifications`). These APIs are provided by Google and subject to Google's terms of service and privacy policy. The Developer is not responsible for how Chrome or Google handles data processed through these APIs. The Software does NOT use Chrome's `chrome.tts` API and does NOT send any text to remote / network speech engines.

## Section 7: Children's Privacy

**7.1** The Software does not knowingly collect, process, or store any information from anyone, including children under the age of 13 (or the applicable age of digital consent in your jurisdiction).

**7.2** If you are under the age of 13 (or the applicable age of digital consent in your jurisdiction), you may use the Software only with the involvement and consent of a parent or legal guardian.

## Section 8: International Privacy Law Compliance

**8.1** APPI (Japan, Primary Applicable Law): The Developer is based in Japan, and the Act on the Protection of Personal Information ("APPI") is the primary privacy framework applicable to the Developer's operation of the Software. The Software does not collect, process, transfer, or disclose personal information as defined under APPI Article 2. Because no personal information is handled, the obligations applicable to Personal Information Controllers under APPI Articles 17 through 28 (including obligations regarding purpose specification, consent for sensitive personal information, third-party transfers, and cross-border data transfers) do not arise from operation of the Software. The Software's zero-data-collection design ensures full compliance with APPI's principles of necessity, purpose limitation, and data minimization.

**8.2** GDPR (European Union / European Economic Area / United Kingdom): The Software does not collect or process personal data as defined by the General Data Protection Regulation (EU) 2016/679 or the UK GDPR. As no personal data is processed, the legal bases for processing (Article 6), data subject rights (Articles 15-22), and data processing agreements (Article 28) do not apply. No data is transferred outside of your device.

**8.3** CCPA / CPRA (California, United States): The Software does not sell, share, or collect personal information as defined under the California Consumer Privacy Act (Cal. Civ. Code § 1798.100 et seq.) or the California Privacy Rights Act. The Software does not engage in cross-context behavioral advertising or profiling.

**8.4** OTHER JURISDICTIONS: The Software's zero-data-collection design is intended to comply with privacy laws in all jurisdictions. Because no personal data is collected, transmitted, or processed, the Software imposes no data-related obligations on the user or the Developer beyond those described in this Privacy Policy.

## Section 9: AI-Generated Content Transparency

**9.1** In accordance with emerging AI transparency requirements (including EU AI Act Article 50 and various state-level synthetic media laws), users should be aware that:

- **(a)** The AI voices provided by the Software generate synthetic speech. Audio produced by the AI voice feature is machine-generated and not a recording of any real person.
- **(b)** The AI voice model was trained on permissive/non-copyrighted audio data as described in the model's official documentation.
- **(c)** The Software does not support voice cloning, voice replication, or generating speech that mimics any specific real person's voice.
- **(d)** Users who distribute AI-generated speech output may be subject to synthetic media disclosure requirements in their jurisdiction.

## Section 10: Data Security

**10.1** All data stored by the Software resides locally on your device within Chrome's sandboxed extension storage, which is isolated from other extensions and websites.

**10.2** The Software does not implement its own encryption for locally stored data (such as voice preferences) because Chrome's extension storage APIs provide origin-level isolation. No sensitive personal data is stored.

**10.3** The Software does not have access to your passwords, financial information, authentication tokens, or any other credentials.

## Section 11: Data Retention and Deletion

**11.1** The Software does not retain any user data beyond the current browser session, with the exception of the locally stored preferences described in Section 3.

**11.2** All data stored by the Software is automatically and permanently deleted when the Software is uninstalled from Chrome.

## Section 12: Changes to This Privacy Policy

**12.1** We may update this Privacy Policy from time to time. If we make material changes, the updated Privacy Policy will be presented to you within the Software upon your next use, and you will be required to review and accept the new terms to continue using the Software.

**12.2** The "Last Updated" date at the top of this Privacy Policy indicates when it was last revised.

**12.3** We encourage you to review this Privacy Policy periodically.

## Section 13: Contact Information

**13.1** If you have questions, concerns, or requests regarding this Privacy Policy, you may contact the Developer via the GitHub Issues page for the GlowReadTTS repository.

## Section 14: Chrome Web Store Compliance

**14.1** The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

**14.2** The Software's use of the "activeTab" and "<all_urls>" permissions is limited to the core functionality of reading webpage text aloud and providing highlight-as-you-read visual feedback, as described in the Software's Chrome Web Store listing.
