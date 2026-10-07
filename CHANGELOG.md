# Changelog

All notable changes to GlowReadTTS are documented here.

## [1.2.0] - 2026-10-08

### Added

- **A pause and resume control on the page, next to the stop button.** A long
  read can be paused and picked up again without opening the popup.
- **Two keyboard shortcuts, one to read the selected text and one to pause or
  resume.** The pause shortcut covers typed text and Test Voice reads too, where
  there is no control on the page. Chrome does not always assign the suggested
  keys, so if a shortcut does nothing, set it at chrome://extensions/shortcuts.
- **The popup shows the keyboard shortcuts you actually have**, read from Chrome
  rather than printed as a fixed key, and says when one is unassigned.

### Changed

- **GlowReadTTS is now licensed under the GNU General Public License v3.0 or
  later, instead of Apache 2.0.** The extension bundles the eSpeak NG speech
  engine, which the voice model relies on to turn text into phonemes, and
  eSpeak NG is GPL-3 licensed. It runs as part of the same program rather than
  as a separate tool, so the extension as a whole is distributed under
  GPL-compatible terms. The full license is in LICENSE, and NOTICE now lists
  every bundled third-party component with its license and where it ships,
  carrying the Apache 2.0 and MIT texts those components are licensed under.
- **The terms of use were updated to match the license.** The clause that gave
  the terms precedence over the open-source licenses has been replaced with one
  stating that those licenses govern, and the general restrictions on how you
  may use the extension have been removed, because the GPL does not permit extra
  conditions on running the software. The no-warranty, liability and privacy
  sections are unchanged. You will be asked to accept the updated terms once.

### Fixed

- **A long opening sentence could stop a read before any audio played.** The
  extension now allows up to 45 seconds for the first audio of a read instead of
  15. Generating the opening sentence of a long passage can take around 14
  seconds, which left almost no margin, and a longer opening could run past the
  old limit entirely. When that happened the read stopped and reported "No audio
  produced" even though the voice engine was working normally. This replaces the
  15 second figure noted under 1.1.0 below.
- **Occasionally the last sentence of a read was dropped.** The extension could
  decide a read had finished while the final sentence was still being prepared,
  then report a normal finish with that sentence never spoken.
- **A short read could finish without playing anything.** Same cause, reached when
  the whole read was a single sentence.
- **Pausing a read no longer ends it.** A read paused while the remaining audio
  was still being prepared could be treated as finished, and the rest of the
  passage was discarded.
- **The sentence highlight no longer drifts while a read is paused.** The
  highlight ran on its own clock, so it carried on through the pause and was
  ahead of the audio on resume. Both of these were reachable from the popup's
  pause button before this release.
- **Screen readers now announce what the extension is doing.** Status changes
  such as Reading, Paused and Finished are read out as they happen, the
  playback buttons have proper names instead of relying on a tooltip, the
  Play/Pause button says which action it will perform, and the Voice and Speed
  controls are linked to their labels in both the popup and the settings page.
- **Changing the speed no longer stops the read.** The read continues and the
  new speed applies to the next one, which the status line now says. Previously
  moving the slider ended the read with no explanation.
- **The popup no longer says "Ready" during a read.** Reopening it mid-read
  showed a "Reading in progress" banner above a status line that still read
  Ready. The status line now matches the banner.

## [1.1.0] - 2026-07-28

A performance and reliability release for AI voice reading. The first read of a
session now starts much sooner, and the voice engine recovers on its own if it
stops responding.

### Added

- **Automatic recovery when the AI voice engine stops responding.** Previously,
  once it stopped working, every subsequent read produced silence with no error
  message, and the only fix was reloading the extension. The engine is now
  checked before each read and rebuilt if it has stopped responding, so the next
  read works after a brief reload pause.
- **A clearer status message while an AI voice starts up**, including a running
  seconds counter, so a slow first load no longer looks like the extension has
  frozen.

### Changed

- **The AI voice now begins loading when you open the popup**, rather than when
  you press Read. Since you typically spend a few seconds choosing a voice or
  typing text, that time is now spent loading instead of adding to the wait. The
  first read of a session starts noticeably sooner. This applies only when an AI
  voice is already your saved default.
- **Switching to an AI voice from the dropdown also starts it loading**, for the
  same reason.
- **A read that produces no audio now reports the problem after about 15
  seconds** instead of 90.
- **Memory:** as a result of the changes above, opening the popup with an AI
  voice selected loads the voice model into memory immediately rather than
  waiting for a read. The existing pre-load preference still controls this;
  turning it off restores the previous on-demand behavior.

### Fixed

- **Right-click reads could stop producing audio after several reads in a row**,
  showing no error and continuing to fail until the extension was reloaded.

## [1.0.0]

Initial public release. Detailed release notes were not kept for this version;
see the commit history for specifics.
