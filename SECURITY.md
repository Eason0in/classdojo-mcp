# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or Security Advisories for security-sensitive reports. Do not open a public issue containing credentials, cookies, student data, browser profiles, real workbooks, or screenshots with personal information.

Include the affected version, operating system, browser version, MCP client, sanitized reproduction steps, and expected impact. Use synthetic names and classes.

## Supported versions

The newest released `0.1.x` version receives security fixes. This project is experimental and depends on a changing third-party web UI, so upgrade to the latest patch before reporting an adapter problem.

## Security boundaries

- The server accepts only a loopback CDP URL by default.
- Authentication stays in the user's dedicated local browser profile.
- Preview data is held in process memory and consumed on the first apply attempt.
- Roster writes require `confirm: true`; this is a safety gate, not an authorization system.
- The selected MCP client and AI provider remain separate data processors outside this repository's control.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the complete trust model.
