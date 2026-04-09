# Green Bot (G.R.E.E.N.)

A configurable Discord server ops + automod bot.

## What it is

**G.R.E.E.N.** stands for **Governance, Response, Enforcement & Engagement Node**.

This project is a starting point for a Discord bot that:

- Manages server structure (categories, channels, archives)
- Provides moderation helpers (ban, roles, automod)
- Supports a config-driven workflow (YAML config stored in durable storage)
- Allows admins to update config from within Discord (upload, validate, apply)

## Getting started

### 1) Install dependencies

```bash
npm install
```

### 2) Provide required environment variables (local/dev)

Set deployment variables:

- `DISCORD_TOKEN` or `DISCORD_TOKEN_SSM_PARAM`
- `APP_ID` (application ID)
- `GUILD_ID` (for guild command registration during development)

Optional:

- `CONFIG_PATH` (defaults to `./config/config.yaml`)
- `CONFIG_S3_BUCKET` (S3 bucket for config store)
- `DYNAMODB_TABLE_NAME` (DynamoDB table for state store)

### 3) Local run

```bash
export DISCORD_TOKEN="<YOUR_TOKEN>"
export APP_ID="<YOUR_APP_ID>"
export GUILD_ID="<YOUR_GUILD_ID>"
npm start
```

## 4) EC2 t4g.nano deployment (very low cost)

This is the recommended low-cost real-time deployment path for production-style operation without Fargate.

### 4.1 Launch instance

1. Create EC2 instance:
    - Instance type: `t4g.nano` (or `t3.micro` if ARM not supported)
    - AMI: Amazon Linux 2023 or Ubuntu LTS
    - Security group: allow SSH from your IP; outbound 443 allowed

2. Optional: assign Elastic IP for stable DNS.

### 4.2 Install and configure

```bash
sudo yum update -y
sudo yum install -y git nodejs npm
# OR Ubuntu:
# sudo apt update && sudo apt install -y git nodejs npm

cd /home/ec2-user
git clone <your-repo-url>
cd greenbot
npm install
```

### 4.3 Set environment vars

```bash
export DISCORD_TOKEN_SSM_PARAM="/greenbot/discord-token"
export APP_ID="<YOUR_APP_ID>"
export GUILD_ID="<YOUR_GUILD_ID>"
export CONFIG_S3_BUCKET="<YOUR_BUCKET>"  # optional
export DYNAMODB_TABLE_NAME="<YOUR_TABLE>"  # optional
```

### 4.4 Create systemd service

`/etc/systemd/system/greenbot.service`:

```ini
[Unit]
Description=Green Bot service
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/greenbot
Environment="DISCORD_TOKEN_SSM_PARAM=/greenbot/discord-token"
Environment="APP_ID=<YOUR_APP_ID>"
Environment="GUILD_ID=<YOUR_GUILD_ID>"
ExecStart=/usr/bin/node /home/ec2-user/greenbot/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 4.5 Start service

```bash
sudo systemctl daemon-reload
sudo systemctl enable greenbot
sudo systemctl start greenbot
sudo systemctl status greenbot
```

### 4.6 SSM parameter (if not in env)

```bash
aws ssm put-parameter --name /greenbot/discord-token --type SecureString --value "<YOUR_TOKEN>" --overwrite
```

### 4.7 Confirm bot connectivity

- Check `sudo journalctl -u greenbot -f`
- Verify `/ping` responds in Discord.

## 4.8 Cost estimate at time of writing

These are approximate pricing estimates (us-east-1, March 2026) for the EC2 approach:

- **t4g.nano EC2**: $3.50–$4.50 / month (on-demand)
- **t3.micro EC2**: $8–$10 / month (on-demand)
- **Elastic IP**: $3.60 / month (if allocated and not in use)
- **EBS storage**: $1–$2 / month (8-20 GB gp3)
- **Data transfer out**: typically low (few MBs) for bots, usually < $1/mo
- **CloudWatch logs**: off by default (see low-cost policy)

Total: **~$5–$8/month** as long as there is only one small EC2 and minimal logging.

If you go the Fargate + ALB route, expect ~ $25–$45/mo as described earlier.

## 4.9 Production cost & uptime policy

To prioritize stability while minimizing cost, implement these mandatory settings:

- **Schedule compute off** nightly: stop the EC2 instance from 11 PM to 9 AM Pacific.
    - Example script (cron on management host / Lambda schedule):
        - `0 23 * * * aws ec2 stop-instances --instance-ids i-... --region us-east-1`
        - `0 9 * * * aws ec2 start-instances --instance-ids i-... --region us-east-1`
- **Use minimal instance size**: `t4g.nano` (us-east-1), as demand is low.
- **No automatic CloudWatch logging** at deploy time; keep logs off by default.
    - Enable only when debugging problems.
- **One single instance only** at this stage to keep costs predictable.
- **Keep DynamoDB enabled** (cheap and stable for state store).
- **Use us-east-1** as primary region for lowest core pricing.
- **S3 lifecycle rule** on config and logs bucket:
    - Delete object versions older than 30 days (or 7 days for logs).
    - Example rule in S3 bucket lifecycle policy: expire 30 days.
- **Budget alarm**:
    - AWS Budget by cost: alert when > $8/month.
    - Use AWS Budgets: `Create budget` > `Cost budget` > `Threshold 8` > email/SNS.

## 5) Developer deployment (AWS CDK)

The `infra/` directory contains CDK code to deploy a Dockerized bot in ECS Fargate with required infrastructure.

Basic steps:

```bash
cd infra
npm install
npx cdk bootstrap
npx cdk deploy --all
```

Then set token in SSM:

```bash
aws ssm put-parameter --name /greenbot/discord-token --type SecureString --value "<YOUR_TOKEN>" --overwrite
```

The stack outputs values for:

- Load balancer DNS
- Config bucket name
- State table name
- Discord token parameter

The bot expects the following (preferred) environment variables:

- `DISCORD_TOKEN` - your bot token (use Secrets Manager / Parameter Store in prod) **OR**
- `DISCORD_TOKEN_SSM_PARAM` - SSM parameter name where the bot token is stored (recommended for prod)
- `GUILD_ID` - guild to register commands into (for development)

Optional:

- `CONFIG_PATH` - path to the config YAML (defaults to `./config/config.yaml`)
- `CONFIG_S3_BUCKET` - S3 bucket name to persist config + versions (used when set)
- `DYNAMODB_TABLE_NAME` - DynamoDB table name for persistent state (strikes/cooldowns). Set via CDK when deployed.

### 3) Run

```bash
npm start
```

## Commands

### Config management (admin-only)

- `/config show` — prints the current config (sanitized, no secrets)
- `/config export` — exports current config as a YAML file
- `/config validate` — validates the most recent YAML attachment in the admin channel
- `/config apply` — applies a validated config and stores it in the configured store
- `/config rollback [version]` — rolls back to a previous stored config version (S3 only)

### Server structure

- `/subject create <name>` — creates a subject category and default channels (from config)
- `/subject channels <subject> <name> <type>` — creates a channel under a subject
- `/channel archive <channel> [reason]` — moves a channel to the archive category and locks it
- `/channel delete <channel> confirm:true [reason]` — deletes a channel (requires confirmation)

### Moderation

- `/mod ban <user> [delete_days] [reason]` — bans a user
- `/mod unban <user_id> [reason]` — unbans a user
- `/mod role <add|remove> <user> <role> [reason]` — adjusts a user's roles
- `/mod timeout <user> <seconds> [reason]` — applies a timeout to a user

### Safe actions

- `/action list` — lists configured safe actions
- `/action add <name> <steps>` — adds a new safe action (JSON/YAML steps)
- `/action run <name>` — runs a safe action defined in the config

## Project structure

- `src/` - application source
- `config/` - default config template

## Notes

This repo is a starting point. Follow the planning doc in `PLANNING.md` to implement additional commands, automod, safe actions, and storage integration.

## Deployment (AWS CDK)

The `infra/` directory contains a CDK app that deploys the bot as a containerized service in AWS (Fargate + SSM + S3).

### Quick deploy steps

1. Install CDK dependencies:

```bash
cd infra
npm install
```

2. Bootstrap your AWS account (once):

```bash
npx cdk bootstrap
```

3. Deploy the stack:

```bash
npx cdk deploy --all
```

### Runtime expectations

- The bot reads the Discord token from an SSM parameter named `/greenbot/discord-token` by default.
- Config storage is backed by an S3 bucket created by the stack.

### Next steps

After deploying, update the SSM parameter with your real token:

```bash
aws ssm put-parameter --name /greenbot/discord-token --type SecureString --value "<YOUR_TOKEN>" --overwrite
```
