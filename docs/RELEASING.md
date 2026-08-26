# Releasing

Releases are maintainer-only and fail closed. Do not push a version tag until all registry setup is complete.

## One-time setup

1. Confirm the public GitHub repository is `Eason0in/classdojo-mcp`.
2. Create a protected GitHub environment named `release` with required reviewers and allow only version tags.
3. Establish ownership of the npm package `classdojo-mcp` with an interactive npm account protected by 2FA. The first publication may require an explicit bootstrap because npm Trusted Publisher settings belong to an existing package.
4. In the npm package settings, configure GitHub Actions Trusted Publishing with:
   - user: `Eason0in`
   - repository: `classdojo-mcp`
   - workflow filename: `release.yml`
   - environment: `release`
   - allowed action: `npm publish`
5. After Trusted Publishing is verified, disallow traditional publish tokens.

Do not store an npm token in this repository. If the initial package-ownership bootstrap is still required by npm, perform it interactively with 2FA, stop, configure Trusted Publishing, and use a new immutable version for the first automated release rather than rerunning an already published version.

## Every release

1. Update `package.json`, `package-lock.json`, `server.json`, and `CHANGELOG.md` to the same new version.
2. Run `npm ci`, `npm test`, `npm run build`, `npm audit --omit=dev`, and `npm pack --dry-run`.
3. Commit and push through the protected branch workflow.
4. Create a signed, immutable tag `v<version>` from the release commit and push it once.
5. Approve the protected `release` environment only after checking the workflow inputs.
6. The workflow verifies version alignment, publishes npm through OIDC, verifies and runs the pinned MCP Registry publisher, then publishes `server.json` through GitHub OIDC.
7. Independently verify the npm version and provenance, GitHub Actions result, and MCP Registry `active`/latest record.

Never recreate a tag, rerun a published npm version, bypass signing, or treat a successful workflow as proof that every public registry updated.
