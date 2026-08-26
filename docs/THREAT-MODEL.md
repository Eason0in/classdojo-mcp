# Threat model

## Assets

- teacher account session
- student names, seat numbers, and class membership
- local workbook and browser profile
- authority to add students to a class

## Trusted components

- the user's operating system and local account
- the selected MCP client and its AI provider
- the dedicated local Chromium profile
- the published npm package and its verified provenance

## Principal risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Accidental write | Preview ID, explicit `confirm: true`, one-time apply, and post-save verification. |
| Duplicate or partial import | Compare existing names, stop subsequent classes after a failure, and generate a new preview before retrying. |
| Seat number stripped by bulk paste | Require an explicit name format; use individual entry for `seat_number_dot_name`. |
| Workbook layout mis-detected | Inspect the entire workbook and require explicit sheet/class mappings before writing. |
| Browser session takeover | Default to loopback CDP and recommend a dedicated browser profile. |
| Sensitive data in support channels | Synthetic fixtures and explicit issue/PR prohibitions. |
| Supply-chain compromise | CI verification, npm Trusted Publishing via OIDC, public provenance, and package allowlisting. |
| ClassDojo UI change | Doctor/state checks, read-back verification, and an explicitly experimental UI-adapter status. |

## Out of scope

- securing a compromised local computer or MCP client
- changing ClassDojo's own authentication, authorization, storage, or retention
- legal determinations for a user's school or jurisdiction
- support for undocumented ClassDojo APIs as a stable contract
