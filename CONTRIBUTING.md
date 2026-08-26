# Contributing

Contributions are welcome, especially synthetic workbook fixtures, locale coverage, MCP client compatibility checks, accessibility-safe browser selectors, and verification improvements.

## Before opening a pull request

1. Create an issue for behavior changes that affect privacy, permissions, or write operations.
2. Use synthetic class and student names in tests, screenshots, commits, and issue text.
3. Add or update tests before changing behavior.
4. Run:

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

5. Confirm no real workbook, browser profile, cookie, token, student name, generated package, or `work/` artifact is tracked.

## Design constraints

- Keep the public tools client-neutral and standard MCP stdio compatible.
- Keep workbook parsing independent from browser automation.
- Keep writes preview-gated and explicitly confirmed.
- Do not depend on undocumented ClassDojo REST routes as a stable public interface.
- Never log to stdout; stdout is reserved for MCP JSON-RPC.
- Treat ClassDojo dialogs and selector changes as detectable states, not permission to bypass them.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
