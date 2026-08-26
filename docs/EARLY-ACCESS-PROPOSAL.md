# ClassDojo API/MCP Early Access proposal

This text is a draft for the official ClassDojo Early Access form. Replace bracketed contact details before submission.

## Short description

I built `classdojo-mcp`, an open-source, local-first MCP server that helps teachers inspect Excel/XLSX rosters, preview roster changes, import students, and verify the saved names and counts. It works across MCP-compatible AI agents rather than being tied to one client.

Repository: https://github.com/Eason0in/classdojo-mcp

## What I want to build with an official API

I would replace the current experimental teacher-web UI adapter with an official, permission-scoped ClassDojo API while keeping the same safety workflow: workbook inspection, explicit class mapping, preview, human confirmation, import, and read-back verification.

The most useful official capabilities would be:

1. list classes visible to the authenticated teacher;
2. read class rosters with stable student IDs and display names;
3. add roster members idempotently, preferably as a validated batch operation;
4. return per-student validation errors and a request/idempotency key;
5. provide OAuth with narrow scopes and revocation, without sharing passwords or browser cookies;
6. expose audit metadata suitable for confirming who changed a roster and when;
7. provide sandbox classes with synthetic student data for integration tests.

## Privacy and safety approach

- The server runs on each teacher's own computer; there is no shared hosted database.
- Student details are omitted from compact previews by default.
- Every roster write requires a preview identifier and explicit confirmation.
- The tool reads the roster back and reports exact count/name differences.
- Public fixtures and screenshots contain synthetic data only.
- Points, attendance, messaging, family invitations, and other sensitive writes are intentionally out of scope.

## Why Early Access would help

An official API would remove browser-selector fragility, improve accessibility and localization support, enable idempotent batch writes, and give schools a clearer permission and audit model. I am willing to provide feedback on API schemas, MCP tool contracts, safety annotations, test cases, and migration from the UI adapter.
