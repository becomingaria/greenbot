# Green Bot (G.R.E.E.N.) — Core User Flows

This document describes the primary user workflows for using Green Bot in a Discord server.
It is intended to be a short, clear reference for admins and moderators on how to operate the bot.

---

## 1) Initial setup (owner / admin)

### 1.1 Create the bot and invite it

1. Create a Discord application and bot in the Discord Developer Portal.
2. Copy the bot token and store it safely (do **not** paste into Discord).
3. Invite the bot to your server with the required permissions (Manage Channels, Manage Roles, Ban Members, Send Messages, etc.).

### 1.2 Configure the bot in AWS (if deployed via CDK)

1. Deploy the infrastructure (if not done already):
    - `cd infra`
    - `npx cdk bootstrap`
    - `npx cdk deploy --all`
2. Set the bot token in SSM:
    ```bash
    aws ssm put-parameter --name /greenbot/discord-token --type SecureString --value "<YOUR_TOKEN>" --overwrite
    ```
3. Note the load balancer DNS output (if you need it for logging/monitoring).

### 1.3 Configure the initial YAML config

1. In the repo, open `config/config.yaml`.
2. Set:
    - `guild.id` to your server ID.
    - `admin.controlChannelId` to the ID of the admin-only channel you want to use.
    - `admin.allowedUserIds` and/or `admin.allowedRoleIds` to allow specific people to run bot admin commands.
3. Start the bot (locally or via Docker/Fargate).

---

## 2) Basic admin workflow (use from Discord)

### 2.1 Verify bot is running

1. In Discord, run `/ping`.
2. Bot should respond with a ping latency.

### 2.2 View current config

1. In the configured admin channel, run `/config show`.
2. Bot will post a sanitized JSON (redactions applied) as a file.

### 2.3 Export config as YAML

1. In the admin channel, run `/config export`.
2. Bot will return a YAML file representing the current effective config.

---

## 3) Updating configuration via Discord (safe workflow)

### 3.1 Prepare a new config

1. Download the current config with `/config export`.
2. Edit the YAML locally.

### 3.2 Upload the new config into the admin channel

1. In the admin channel, upload the edited YAML file as an attachment.
2. Ensure the file is visible in that channel.

### 3.3 Validate before applying

1. Run `/config validate` in the admin channel.
2. Bot will:
    - Find the most recent attachment from you in that channel.
    - Parse the YAML/JSON.
    - Validate it against schema.
3. If the validation succeeds, the bot confirms.
4. If it fails, the bot prints errors.

### 3.4 Apply the new config

1. Run `/config apply` in the admin channel.
2. Bot will:
    - Persist the config to the configured store (S3 if configured, otherwise local file)
    - Save a versioned backup (timestamped)
    - Reload its runtime config
    - Confirm success

### 3.5 Roll back to a previous config (S3 only)

1. Run `/config rollback` to rollback to the latest stored version.
2. To rollback to a specific version, run `/config rollback version:<timestamp>`.
3. The bot will confirm the rollback and reload the config.

---

## 4) Admin / moderation workflows

### 4.1 Running privileged commands

1. Ensure your user is allowed (in `admin.allowedUserIds` or has a role in `admin.allowedRoleIds`).
2. Run commands in the configured admin control channel.

#### Server structure
- `/subject create <name>` — create a category + default channels (from config).
- `/subject channels <subject> <name> <type>` — create a channel under a subject.
- `/channel archive <channel>` — move a channel into the archive category and lock it.
- `/channel delete <channel> confirm:true` — delete a channel (requires confirmation).

#### Moderation
- `/mod ban <user> [delete_days] [reason]` — ban a user.
- `/mod unban <user_id> [reason]` — unban a user.
- `/mod role <add|remove> <user> <role> [reason]` — add/remove a role.
- `/mod timeout <user> <seconds> [reason]` — timeout a user.

#### Safe actions
- `/action list` — list configured safe actions.
- `/action run <name>` — run a safe action defined in config.

---

## 5) Automod + Q&A workflows (future)

### 5.1 Automod (planned)

- Users who trigger banned words / spam will be automatically warned or moderated.
- This is configured via the `moderation` section in the YAML.

### 5.2 Q&A responses (planned)

- Admins define `qa.rules` in the config.
- Messages matching rules trigger automatic bot replies.

---

## 6) When things go wrong

### 6.1 Bot is not responding

- Verify the bot container is running and connected.
- Check the bot’s logs in ECS/CloudWatch (when deployed).

### 6.2 Config isn’t applying

- Run `/config validate` to see schema errors.
- Confirm the YAML you uploaded is the latest attachment in the admin channel.

### 6.3 Need to recover quickly

- Run `/config rollback` from the admin channel to restore the last stored configuration.

---

## Notes

- All admin workflows assume the correct `admin.controlChannelId` is set.
- The bot uses **S3 versioning** for config backups; if S3 is not configured, it falls back to local file writes.
- Always keep the bot token private and store it in SSM (never in Discord messages).
