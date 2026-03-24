# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.2.0] - 2026-03-24

### Added

- Added a direct Weixin-to-Codex runtime that can log in with Weixin QR code, long-poll `getupdates`, and control a local `codex app-server` without using OpenClaw as the runtime host.
- Added the Weixin command set for workspace and thread control: `/codex bind`, `/codex where`, `/codex workspace`, `/codex new`, `/codex switch`, `/codex message`, `/codex stop`, `/codex model`, `/codex effort`, `/codex approve`, `/codex reject`, `/codex remove`, `/codex send`, and `/codex help`.
- Added file delivery from the current workspace with `/codex send <path>`, including image-as-image and video-as-video sending behavior.
- Added persisted `contextToken` storage so Weixin conversation context can survive a `codex-wechat` process restart.
- Added cleanup for stale account state after login, including old account records, sync buffers, and persisted context tokens for the same Weixin user.
- Added initial project documentation in `README.md` and `Usage.md`.
- Added a top-level `CHANGELOG.md`.

### Changed

- Changed `/codex new` to switch into a new-thread draft state and only create the real Codex thread when the next plain-text message arrives.
- Changed plain-text message handling so normal chat input is no longer confused with `/codex message`.
- Changed login output to print a browser-openable QR URL as a fallback when terminal QR rendering is unavailable or unclear.
- Changed account listing so internal `*.context-tokens.json` files are not treated as saved bot accounts.

### Fixed

- Fixed stale empty-thread behavior caused by `thread/start` followed by `thread/resume` on threads with no rollout history.
- Fixed reply failures after restart by restoring cached Weixin conversation tokens before the next outbound reply.
- Fixed sensitive Weixin values leaking into error output by redacting `bot_token`, `context_token`, authorization headers, and upload parameters in logged API failures.
- Fixed media sending support for workspace-relative file resolution and Weixin media message construction for files, images, and videos.
