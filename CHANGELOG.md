# Changelog

All notable changes to GlowReadTTS are documented here.

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
  waiting for a read. The existing pre-load preference still controls this —
  turning it off restores the previous on-demand behavior.

### Fixed

- **Right-click reads could stop producing audio after several reads in a row**,
  showing no error and continuing to fail until the extension was reloaded.

## [1.0.0]

Initial public release. Detailed release notes were not kept for this version;
see the commit history for specifics.
