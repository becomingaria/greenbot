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

### 2) Provide required environment variables

The bot expects the following (preferred) environment variables:

- `DISCORD_TOKEN` - your bot token (use Secrets Manager / Parameter Store in prod)
- `GUILD_ID` - guild to register commands into (for development)

Optional:

- `CONFIG_PATH` - path to the config YAML (defaults to `./config/config.yaml`)

### 3) Run

```bash
npm start
```

## Command(s)

This initial version includes:

- `/config show` - prints the current config (sanitized, no secrets)

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
