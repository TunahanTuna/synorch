# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Fixed

- Pin npm 11.19.1 in the release workflow so npm Trusted Publishing is available on Node.js 24 runners.

## [0.1.0] - 2026-09-20

### Added

- Provider-neutral orchestration structure generation for Codex and Claude Code.
- Safe `inspect`, `init`, `sync`, and `doctor` CLI commands exposed through `syn` and `synorch`.
- Evidence-driven repository and workspace discovery for JavaScript, TypeScript, Java, Python, Rust, and Go projects.
- Automatic technology skill selection for React, Java, Spring Boot, JPA, Node.js, Vue, Nuxt, and Tailwind CSS.
- A bundled, provenance-tracked Ingenium skill catalog with on-demand loading rules.
- Model profiles, orchestration protocols, minimal context packets, verification contracts, and provider adapters.

[Unreleased]: https://github.com/TunahanTuna/synorch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TunahanTuna/synorch/releases/tag/v0.1.0
