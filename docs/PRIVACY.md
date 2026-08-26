# Privacy

ClassDojo Roster MCP is a local command-line process. It does not operate a hosted backend, analytics endpoint, telemetry collector, or account database.

## Data flow

1. The MCP client starts the local stdio server.
2. The server reads the workbook path selected by the user.
3. Read-only preview results are returned to the MCP client. Student details are omitted by default unless `includeStudentDetails: true` is requested.
4. After explicit confirmation, selected student display names are entered into the user's signed-in local ClassDojo browser session.
5. The server reads the roster back for verification.

Preview content remains in process memory only, expires after 15 minutes, and is removed on the first apply attempt or when the process exits. The repository does not persist student rosters.

## Important boundary

Local-first does not mean the data never leaves the computer: the selected MCP client or AI provider may receive tool arguments and results, and ClassDojo receives confirmed roster writes. Users must evaluate those services' policies and follow applicable school, contractual, privacy, and child-data requirements.

Use a dedicated browser profile, minimum necessary workbook data, synthetic fixtures for support, and a trusted MCP client configuration. Never expose the CDP endpoint beyond loopback.
