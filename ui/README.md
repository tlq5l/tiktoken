# ui

To install dependencies:
bun install
To run the server (with API routes like /api/repo/files and /api/repo/ignore):
bun run dev
# or
bun run start
# which runs: bun src/server.ts
Then open:

- Token counter and basic context builder: http://localhost:4747/
- Workspace selector: http://localhost:4747/workspace.html
- Repo prompt UI: http://localhost:4747/repo-prompt.html

Troubleshooting:

- If you see api/repo/ignore ... 404 (Not Found) or JSON parse errors like "Not found is not valid JSON", ensure you started the server
with bun run dev (or bun run start). Running bun run index.ts does not launch the API server.
- File list includes ignored files? The server respects:
    - Git ignores (via git check-ignore, including nested .gitignore)
    - Global defaults
    - Extra patterns you set in the UI (Ignore modal)
Make sure git is installed and the path points to a repository (use the "Select Codebase" button or POST /api/repo/change).

This project was created using bun init in bun v1.2.20. Bun (https://bun.com) is a fast all-in-one JavaScript runtime.
