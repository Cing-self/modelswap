# CHANGELOG

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.0] - 2026-08-20

### Added

- **Key Vault**: AES-256-GCM encrypted local key storage with project binding (`.okitenv` → `.env`), shell hook auto-injection, and encrypted cloud sync (Cloudflare KV/D1/R2, Supabase, Volcengine KMS) + LAN peer-to-peer sync via pairing codes
- **29+ Provider Presets**: Built-in presets for major AI model providers (international official, aggregator, Chinese platforms) with multi-endpoint protocol support (anthropic/openai-compatible)
- **10 Agent Adapters**: Surgical config switching for Claude Code, ChatGPT Codex, Kimi Code, WorkBuddy, Hermes, OpenCode and more — snapshots before each switch, one-click restore in Settings
- **Auto-create API Keys**: Browser extension auto-fills provider console forms and files keys back to the vault (31 platforms including Volcengine, Zhipu, Baidu Qianfan)
- **Usage Queries**: Direct API queries across 15 platforms for subscription/balance/usage with threshold alerts (local notification)
- **Model Catalog**: Platform-consolidated official pricing & capability data (input/output/cache prices, context windows, peak/off-peak pricing)
- **CI**: Three-platform CI (macOS, Linux, Windows) with lint, typecheck, test, and frontend build

### Changed

### Fixed