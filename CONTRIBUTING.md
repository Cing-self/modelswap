# Contributing to OKIT

Thanks for your interest in contributing to OKIT!

## Project Structure

```
src/
  main.ts                  # CLI entrypoint (Commander.js)
  commands/                # CLI command implementations
  providers/               # Provider/model management (TypeScript)
    store.ts               # CRUD on ~/.okit/providers.json
    presets.ts             # 29+ built-in provider presets
    adapters/              # Per-agent config writers
    registry.ts            # Agent-to-adapter mapping
  vault/                   # AES-256-GCM encrypted key storage (TypeScript)
  config/                  # User config & i18n (TypeScript)
  web/
    server.js              # Express backend (CommonJS, NOT TypeScript)
    api/                   # API route handlers (CommonJS)
    frontend/              # React + TypeScript + Vite (src/web/frontend/)
      src/
        components/        # Feature-based UI components
        styles/            # CSS files using CSS variables
        i18n/              # zh.ts / en.ts bilingual strings
```

## Requirements

- Node.js 20+
- npm

## Commands

| Command | Description |
|---------|-------------|
| `npm ci --ignore-scripts` | Install dependencies (skip postinstall which needs dist) |
| `npm run build` | Full build: tsc + copy web/api + copy tool YAMLs + frontend build |
| `npm run dev` | Run CLI in dev mode via ts-node |
| `npx vitest run` | Run all tests |
| `cd src/web/frontend && npm run dev` | Frontend dev server on :5173 (proxies /api → :3780) |
| `cd src/web/frontend && npm run build` | Build frontend to dist/web/public/ |

## Code Style

- **Backend API** (`src/web/api/*.js`): CommonJS only — no TypeScript syntax, no ESM imports/exports.
- **File writes**: Use `atomicWrite` (from `src/vault/store.ts`) to prevent partial writes.
- **UI strings**: Always provide both `zh` and `en` entries in `src/web/frontend/src/i18n/`.
- **CSS**: Use the project's CSS variables (`--paper`, `--kraft`, `--ink`, etc.). Dark mode via `[data-theme="dark"]` selectors. Split styles by feature in `src/web/frontend/src/styles/`.
- **Formatting**: Prettier with default settings. Run `npx prettier --write` before committing.

## Pull Requests

1. Tests must pass (`npx vitest run`)
2. TypeScript must compile (`npx tsc --noEmit`)
3. Frontend must build (`cd src/web/frontend && npm run build`)
4. Keep changes scoped — prefer small, focused PRs over large rewrites
5. Add or update tests when introducing new features