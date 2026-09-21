# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-21
### Added

- A canonical, provider-neutral Task Conductor base skill for dependency-aware decomposition and just-in-time skill routing.
- Explicit `trivial`, `standard`, and `high-risk` execution tiers in task context contracts.

### Changed

- Scale planning, worker count, verification, and independent review to task risk instead of applying the full workflow to every change.
- Make headed-browser verification opt-in and require the cheapest sufficient evidence first.
- Distinguish available catalog skills from active project skills and task-loaded skills; the catalog is no longer scanned during session bootstrap.
- Move Task Conductor out of the Ingenium snapshot so it has one canonical source of truth.
- Existing 0.1.x structures must be reviewed and regenerated with `syn init --force` followed by `syn sync --force` to adopt the new canonical contracts.

### Fixed

- Run the pinned npm 11.19.1 CLI directly so Trusted Publishing is reliable on Node.js 24 runners.

## [0.1.0] - 2026-09-20

### Added

- Provider-neutral orchestration structure generation for Codex and Claude Code.
- Safe `inspect`, `init`, `sync`, and `doctor` CLI commands exposed through `syn` and `synorch`.
- Evidence-driven repository and workspace discovery for JavaScript, TypeScript, Java, Python, Rust, and Go projects.
- Automatic technology skill selection for React, Java, Spring Boot, JPA, Node.js, Vue, Nuxt, and Tailwind CSS.
- A bundled, provenance-tracked Ingenium skill catalog with on-demand loading rules.
- Model profiles, orchestration protocols, minimal context packets, verification contracts, and provider adapters.

[Unreleased]: https://github.com/TunahanTuna/synorch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/TunahanTuna/synorch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TunahanTuna/synorch/releases/tag/v0.1.0
