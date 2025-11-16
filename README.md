# Plexi Backup Bot (Mid-Tier Clone)

Features:
- `/backup create <name>` or `$backup create <name>` — creates a backup of roles + channels (with perms + overwrites)
- `/backup list` or `$backup list` — lists backups for the guild
- `/backup load <id>` or `$backup load <id>` — restores a backup (creates roles & channels, applies perms)
- `/backup delete <id>` or `$backup delete <id>` — deletes a saved backup

Storage: Local SQLite database (file: data/backups.sqlite)

Quick start:
1. `git clone <repo>`
2. `npm install`
3. Copy `.env.example` to `.env` and fill `DISCORD_TOKEN` and `CLIENT_ID`.
4. `node index.js`

Notes:
- Bot requires `Administrator` (recommended for full restore) in guilds where it runs.
- The bot attempts best-effort to avoid collisions (it appends suffixes when names exist).
- "/" commands may take time to fetch


If you want any changes please open an Issue or DM me on discord @1rgl or @reobfuscation
