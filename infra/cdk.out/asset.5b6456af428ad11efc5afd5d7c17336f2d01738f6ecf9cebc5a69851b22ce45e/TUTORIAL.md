# Green Bot (G.R.E.E.N.) — Tutorial & Milestones

This document is a walkthrough for setting up, running, and using Green Bot in your Discord server. It also maps the current capabilities against the planned milestone list so you can move through features systematically.

---

## ✅ Current capabilities (what works today)

### Core runtime

- ✅ Bot boots using `discord.js` and registers slash commands.
- ✅ Config is loaded from YAML (local file) and validated with Joi.
- ✅ Config can be stored in S3 with versioned backups.
- ✅ Config updates are performed via Discord admin channel (upload + validate + apply).

### Implemented commands

- `/ping` — health check
- `/config show` — show sanitized current config
- `/config export` — export current config as YAML
- `/config validate` — validate the most recent attached config YAML/JSON
- `/config apply` — apply the validated config (persist + reload)
- `/config rollback` — rollback to a previous config version (S3-backed)

### Deployment support

- ✅ Dockerized Node.js app
- ✅ AWS CDK stack that deploys the bot on ECS Fargate
- ✅ Discord token stored in SSM (secure)
- ✅ Config stored in a versioned S3 bucket (created by CDK)

---

## 📌 Milestone checklist (systematic progress)

### Milestone 1 (Baseline) — ✅ Done

- Bootstrapping project structure
- Config loader + schema validation
- Slash command framework
- `/config show` output

### Milestone 2 (Config store + versioning) — ✅ Done

- S3 storage for config (optional via env var `CONFIG_S3_BUCKET`)
- `/config export` (download YAML)
- `/config validate` (validate uploaded YAML)
- `/config apply` (apply + version + audit-ready)
- `/config rollback` (version rollback)

### Milestone 3 (Server structure automation) — 🚧 In progress

Planned commands:

- `/subject create <name>` (create category + default channels)
- `/subject channels add <subject> <channelName> <type>`
- `/channel archive <channel>` (move & lock channel)
- `/channel delete <channel>` (delete with optional confirm)

### Milestone 4 (Moderation + automod) — 🚧 Planned

Planned commands and features:

- `/mod ban` / `/mod unban`
- `/mod role add/remove`
- Automod pipeline (spam, banned words, link rules)
- Strike tracking / escalations

### Milestone 5 (Q&A + safe actions) — 🚧 Planned

- Rule engine for keyword/regex responses
- Safe action workflows (`/action add`, `/action run`)

### Milestone 6 (AWS deploy) — ✅ Done

- CDK infra (Fargate + S3 + SSM)
- Deployment instructions included in `README.md`

---

## 🧰 Getting started (setup)

### 1) Clone & install

```bash
git clone <repo-url>
cd greenbot
npm install
```

### 2) Set up local config

Copy and edit `config/config.yaml`.

Required fields:

- `guild.id` — your server ID
- `admin.controlChannelId` — the ID of the admin channel used for config commands
- `admin.allowedUserIds` / `admin.allowedRoleIds` — who can run admin operations

### 3) Run locally

```bash
export DISCORD_TOKEN="<token>"
export APP_ID="<your-app-id>"
export GUILD_ID="<your-guild-id>"
npm start
```

> This will register commands in your guild (development mode) and keep the bot running.

---

## 🧩 How config works (YAML format)

Config is stored in YAML and validated against a schema.
The primary sections are:

### `guild`

- `id` (string) — the guild/server ID

### `admin`

- `controlChannelId` (string) — the channel in which admin commands work
- `allowedUserIds` (array of strings) — users that can run admin commands
- `allowedRoleIds` (array of strings) — roles that can run admin commands
- `requireDiscordPermissions` (bool) — require Discord perms in addition to the above

### `logging`

- `level` — `debug|info|warn|error`
- `auditChannelId` — optional channel for audit messages
- `redact` — keys to redact when showing config (e.g., `token`, `secrets`)

### `features`

Feature toggles for major bot functionality. Example:

```yaml
features:
    subjects: true
    moderation: true
    qa: true
    safeActions: true
    archive: true
```

### `subjects` (planned)

Config for category/channel creation and archiving.

### `moderation` (planned)

Rules and policies for automod (spam, banned words, links, strikes).

### `qa` (planned)

Rules for keyword/regex-triggered automated responses.

### `safeActions` (planned)

Named workflows composed of whitelisted steps (no arbitrary code).

---

## 🧪 Config workflow (use in Discord)

1. **Export current config**: `/config export` (download YAML)
2. **Edit locally** (edit YAML file)
3. **Upload edited file** to the admin channel
4. **Validate**: `/config validate` (parses and validates the most recent attachment)
5. **Apply**: `/config apply` (persists the config and reloads it)
6. **Rollback**: `/config rollback [version]` (restore previous version)

---

## 🚀 Deployment (AWS)

The repo includes a CDK stack under `infra/`.

### Deploy steps (quick)

```bash
cd infra
npm install
npx cdk bootstrap
npx cdk deploy --all
```

After deploy, update the token:

```bash
aws ssm put-parameter --name /greenbot/discord-token --type SecureString --value "<YOUR_TOKEN>" --overwrite
```

---

## ✅ Next immediate project tasks (pick one)

1. **Implement `/subject` server-structure commands** (Milestone 3)
2. **Implement `/mod` moderation commands + automod pipeline** (Milestone 4)
3. **Implement Q&A + safe actions engine** (Milestone 5)

---

## Notes

- The bot loads config from S3 when `CONFIG_S3_BUCKET` is set.
- If S3 is not configured, it uses the local `config/config.yaml` file.
- Admin commands require the configured control channel and user/role membership.
- Token should always be stored securely (SSM is recommended).
