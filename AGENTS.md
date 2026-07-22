# AGENTS.md

## Purpose

- This repository builds a local, fail-open Codex Router and its native macOS menu-bar control surface.
- Treat `docs/ARCHITECTURE.md` as the implemented design contract. `docs/ROUTING-STRATEGY.md` is a proposal until its status says otherwise.

## Work Boundaries

- Preserve the transparent-proxy invariant: do not rewrite prompts, permissions, sandbox settings, or tool configuration.
- Keep Router and Gateway responsibilities separate. Router selects `model`, `effort`, and `serviceTier`; provider credentials and protocol translation remain Gateway concerns.
- Keep changes minimal and do not revert unrelated user work.
- Do not edit generated output under `dist/`, SwiftPM `.build/`, or installed app bundles directly.

## Validation

- TypeScript changes: run `pnpm check` and `pnpm build`.
- Swift changes: also run `pnpm build:macos`.
- Before committing, run `git diff --check` and review the complete staged diff.

## Git Identity

- Create commits in this repository with the repository-local identity `DeyunMa <121009814+DeyunMa@users.noreply.github.com>`.
- Do not fall back to the global `DeyunMa-1` identity.
- Do not push unless the user explicitly requests it.
