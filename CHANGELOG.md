# Changelog

All notable changes are documented here. This project follows Semantic Versioning after the first public release.

## [Unreleased]

## [0.1.2] - 2026-08-26

### Changed

- Upgraded the runtime schema dependency to Zod 4 and raised the MCP SDK minimum to the compatible 1.30 release line.
- Upgraded the development toolchain to TypeScript 7, Vitest 4, and Node.js 26 type definitions.
- Added tested MCP Registry recovery safeguards without changing the Node.js 20+ runtime requirement.

## [0.1.1] - 2026-08-26

### Changed

- Published through npm Trusted Publishing with GitHub OIDC provenance.
- Added the live npm package status and installation instructions.

## [0.1.0] - 2026-08-26

### Added

- Standard MCP stdio server and npm CLI.
- Whole-workbook XLSX roster inspection with dynamic class/seat/name block detection.
- Explicit `seat_number_dot_name` and `name_only` import modes.
- Preview ID plus `confirm: true` write gate.
- ClassDojo read-back verification for counts and exact names.
- Local Chrome CDP doctor and blocking-dialog state detection.
- MCP Registry metadata, client-neutral setup documentation, synthetic snapshots, CI, and Trusted Publishing workflow.
