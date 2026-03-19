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

- `/subject create <name>` — create a category + default channels (from config), create a role (`name` or configured prefix), and restrict channel access to that role.
- `/subject channels <subject> <name> <type>` — create a channel under a subject (and preserves the subject role permissions for private sections).
- `/subject join <subject>` — join an existing subject by getting the subject role.
- `/channel archive <channel>` — move a channel into the archive category and lock it.
- `/channel delete <channel> confirm:true` — delete a channel (requires confirmation).

##### Example private group workflow

1. Set in config:
    - `subjects.defaultChannels` includes `vanilla-chat`, `vanilla-memes`, `vanilla-rules`, `vanilla-voice-chat`.
2. Admin runs `/subject create vanilla`.
3. Bot creates:
    - category `vanilla`
    - role `vanilla` (or subject-prefixed role)
    - channels (text/voice) under category
4. Admin runs `/member set user#1234 vanilla` (or `/member batch` with user:role lines).
5. User joins or existing user gets role immediately.

## 5) Member role templates (auto-assign)

- `/member set <user> <roles>` — map username/id to a fixed role list.
- `/member remove <user>` — remove the stored mapping.
- `/member list` — show all mappings.
- `/member batch <data>` — upload newline lines like `user#1234: vanilla, member`.

Behavior:

- mapping is stored in DynamoDB state.
- new members receive mapped roles on join if they have mapping by user ID or tag.
- existing members are updated when mapping is set.
    - permission overwrites: `@everyone` cannot view; role can view & send/join.

4. Member runs `/subject join vanilla` (or admin /mod role add @user vanilla) to grant access.

#### Moderation

- `/mod ban <user> [delete_days] [reason]` — ban a user.
- `/mod unban <user_id> [reason]` — unban a user.
- `/mod role <add|remove> <user> <role> [reason]` — add/remove a role.
- `/mod timeout <user> <seconds> [reason]` — timeout a user.

#### Safe actions

- `/action list` — list configured safe actions.
- `/action add <name> <steps>` — add a safe action to config (JSON/YAML steps).
- `/action run <name>` — run a safe action defined in config.

---

## 5) Reminder + Remember workflows

### 5.1 /remind workflows

- `/remind create when:<time> message:<text> [channel:<channel>]`
    - Example: `/remind create when:in 30m message:Daily standup starts soon`.
    - Example: `/remind create when:every Monday at 09:00 message:Weekly planning`.
    - Example: `/remind create when:cron:0 9 * * 1 message:Monday review`
    - Example: `/remind create when:in 3 business days message:Follow up with partner`.

- `/remind list` — lists your upcoming reminders.

- `/remind show id:<id>` — show detailed info for one reminder.

- `/remind edit id:<id> [when:<time>] [message:<text>] [recurrence:<expr>]`
    - Example: `/remind edit id:abc123 when:tomorrow at 11:00 message:Updated time`.

- `/remind snooze id:<id> duration:<interval>`
    - Example: `/remind snooze id:abc123 10m` (push the due time by 10 minutes).

- `/remind cancel id:<id>` — cancel a reminder.

- `/remind clone id:<id>` — duplicate an existing reminder into a new reminder with new ID.

### 5.2 /remember workflows

- `/remember set key:<key> value:<value>` — store an entry for the server.
    - Example: `/remember set docs-url https://example.com/docs`.

- `/remember get key:<key>` — retrieve a value and extend dissipation TTL (30 days default).

- `/remember list` — show remembered keys and expires-in.

- `/remember delete key:<key>` — remove an entry.

- `/remember export` — export all entries as a YAML file.

### 5.3 Automod + Q&A workflows (current)

- `/automod` logic is active based on `moderation` config.
    - Spam limits, banned phrases, link filtering, and strike escalation are automatic.

- `/qa` rules are active based on `qa.rules` config.
    - Messages matching trigger words produce configured replies.

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
