# Contributing

Enve Family runs on Node.js 22.13 or newer. Install dependencies with `npm ci`, then start the dashboard with `npm start`. The web interface is plain HTML, CSS, and JavaScript; it has no build step.

Before sending a change, run `npm run format:check` and `npm test`. If you changed the interface, check the affected flow in a browser at both desktop and phone widths. If you changed the native Pi display, build it with CMake and check it against a disposable database.

Keep account credentials, calendar exports, backups, household photos, and local databases out of commits. Use invented people and events in tests and screenshots. Put local settings in `.env`, using `.env.example` as a guide.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), rather than in a public issue.

Small, focused changes are easiest to review. Add comments where the reason for a decision would otherwise be unclear. Describe what you tested in a pull request.

Contributions are accepted under the same AGPL-3.0-only license as the project. Contributors retain ownership of their work.
