# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.2.1] - 2026-04-23

### Added

- Added a streaming-style Weixin markdown filter so outbound replies can preserve more readable structures such as fenced code blocks, tables, and common inline formatting instead of flattening everything to plain text.
- Added `iLink-App-Id` and computed `iLink-App-ClientVersion` headers to the Weixin API layer, and exposed a shared GET request helper for QR login polling.

### Changed

- Changed QR login to start from the fixed `https://ilinkai.weixin.qq.com` entrypoint and follow `scaned_but_redirect` host redirects returned by the Weixin login API.
- Changed QR status polling to treat transient network and gateway errors as retryable wait states instead of failing the whole login flow immediately.
- Changed package metadata and local checks so the Weixin runtime publishes `ilink_appid: "bot"` and syntax validation includes the new markdown filter module.
- Changed project documentation to reflect current Weixin attachment handling and the new outbound markdown compatibility behavior.

### Fixed

- Fixed outbound media upload compatibility with newer Weixin CDN responses by accepting `upload_full_url` in addition to legacy `upload_param`.
- Fixed inbound attachment download compatibility with newer Weixin media payloads by accepting `full_url` in addition to legacy encrypted query parameters.
- Fixed attachment normalization so newer Weixin media items keep both direct full URLs and `media.full_url` references for later download and decryption.

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
