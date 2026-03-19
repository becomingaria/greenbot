# Green Bot (G.R.E.E.N.) Planning & Roadmap

This document is the single source of truth for what we are building, how we prioritize, and what remains to be implemented.

---

## ✅ Current status (what's in repo right now)

- Basic Node.js Discord bot scaffold using `discord.js`.
- Config loader that reads a YAML file, validates it with Joi, and supports redaction.
- `/ping` command for health checks.
- `/config show` command that prints the sanitized config.
- Default config schema & example in `config/config.yaml`.

---

## 🎯 Goals (aligned with the original plan)

### Core features
- [ ] Server structure automation (categories, channels, archives)
- [ ] Moderation automation (ban/kick, role changes, timeout)
- [ ] Config-driven behavior (load/apply/rollback/config versioning)
- [ ] Message-based automod (spam, banned words, link rules)
- [ ] Q&A (trigger → response) rules
- [ ] Safe extension system (whitelisted actions / recipes)

### Operations & safety
- [ ] Admin control channel enforcement
- [ ] Permission gating (bot admins + Discord permissions)
- [ ] Config validation + rollback + versioning (S3-based)
- [ ] Audit logging (CloudWatch/S3 or Discord audit channel)
- [ ] Secret handling (Discord token via SSM/Secrets Manager)

### Deployment
- [ ] Cheap, continuously-running deployment (AWS)
- [ ] Docker container + infra (CDK) for repeatable deploys
- [ ] Config & state persistence in AWS (S3, optional DynamoDB)

---

## 🧭 Milestones (next steps)

### Milestone 1 (Baseline)
- [x] Bootstrapping project structure
- [x] Config loader & schema validation
- [x] Basic slash command framework
- [x] `/config show` output

### Milestone 2 (Config store + versioning)
- [ ] Add S3 storage for config
- [ ] Add `/config export` (upload file)
- [ ] Add `/config validate` (validate uploaded YAML)
- [ ] Add `/config apply` (apply + version + audit)
- [ ] Add `/config rollback` (change to previous version)

### Milestone 3 (Server structure automation)
- [ ] `/subject create <name>` (category + default channels)
- [ ] `/subject channels add ...`
- [ ] `/channel archive` / `/channel delete`

### Milestone 4 (Moderation + automod)
- [ ] `/mod ban` / `/mod unban`
- [ ] `/mod role add/remove`
- [ ] Automod pipeline (spam/banned words/links)
- [ ] Strike tracking and escalation

### Milestone 5 (Q&A + safe actions)
- [ ] Q&A rule engine with cooldowns
- [ ] Safe action runner (named workflows)
- [ ] `/action add` / `/action run`

### Milestone 6 (AWS deploy)
- [ ] Add CDK infrastructure for running the bot
- [ ] Document deployment steps (bootstrap, deploy, env vars)
- [ ] Ensure bot can read config from S3 and token from SSM

---

## 🔧 How to use this doc

- Keep the “Current status” section up to date as you implement features.
- Use the milestone checklist as a quick way to know what to work on next.
- If you add a new feature that changes the config schema, update `config/config.yaml` and the Joi schema in `src/config.js`.

---

## 📌 Notes / Open questions

- Would be nice to support multi-guild from the start, but we can start with a single-guild config and expand later.
- We should decide on a persistent store for strikes/cooldowns (DynamoDB recommended).
- We should align on whether config is stored in the repo (as YAML) or only in S3 + in-memory (for production).
