# Security Policy

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's private security advisory feature for this repository, or email `enve.audiobook@gmail.com` if private advisories are unavailable.

Include the affected version, steps to reproduce, and likely impact. Remove real credentials, calendar entries, household photos, server addresses, and database contents from logs or screenshots.

Security fixes are made against the current `main` branch. Older releases are not guaranteed long-term support.

## Deployment boundary

Enve Family is a self-hosted app for a household network. The server stores calendar credentials and household data locally. Keep `.env`, `data/`, backups, and connection keys private. Use HTTPS or an encrypted tunnel for remote access; do not expose the HTTP server directly to the public internet.
