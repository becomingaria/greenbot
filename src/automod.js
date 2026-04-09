import { URL } from "url"

import { StateStore } from "./state.js"
import { auditLog } from "./audit.js"

const messageHistory = new Map()

function getHistoryKey(guildId, userId) {
    return `${guildId}:${userId}`
}

function cleanupHistory(guildId, userId, windowMs) {
    const key = getHistoryKey(guildId, userId)
    const now = Date.now()
    const history = messageHistory.get(key) ?? []
    const filtered = history.filter((t) => now - t <= windowMs)
    messageHistory.set(key, filtered)
    return filtered
}

function addMessageTimestamp(guildId, userId) {
    const key = getHistoryKey(guildId, userId)
    const now = Date.now()
    const history = messageHistory.get(key) ?? []
    history.push(now)
    messageHistory.set(key, history)
    return history
}

const stateStore = new StateStore({
    tableName: process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
})

function parseUrls(text) {
    const urlRegex = /https?:\/\/[\w\-./?%&=~#,:;+@]+/gi
    const matches = text.match(urlRegex)
    if (!matches) return []
    return [...new Set(matches)]
}

function domainFromUrl(urlText) {
    try {
        const u = new URL(urlText)
        return u.hostname.toLowerCase()
    } catch {
        return null
    }
}

export async function runAutomod(message, config, actions) {
    if (!config.features?.moderation) return
    if (!message.guild || message.author.bot) return

    const modCfg = config.moderation ?? {}
    if (!modCfg) return

    if (modCfg.excludedChannelIds?.includes(message.channelId)) return

    const text = message.content || ""
    const userId = message.author.id
    const guildId = message.guild.id

    // Spam check
    if (modCfg.spam?.enabled) {
        const windowMs = (modCfg.spam.windowSeconds ?? 10) * 1000
        const max = modCfg.spam.maxMessagesPerWindow ?? 6
        const history = cleanupHistory(guildId, userId, windowMs)
        history.push(Date.now())
        addMessageTimestamp(guildId, userId)
        if (history.length > max) {
            return await performAction(
                message,
                modCfg.spam.action ?? "warn",
                modCfg.spam,
                config,
                actions,
            )
        }
    }

    // Banned phrases
    for (const phrase of modCfg.bannedPhrases ?? []) {
        if (!phrase) continue
        if (text.toLowerCase().includes(phrase.toLowerCase())) {
            return await performAction(
                message,
                modCfg.strikes?.enabled
                    ? null
                    : (modCfg.spam?.action ?? "warn"),
                modCfg,
                config,
                actions,
                phrase,
            )
        }
    }

    // Link checks
    if (modCfg.links?.enabled) {
        const allowlist = (modCfg.links.allowlistDomains ?? []).map((d) =>
            d.toLowerCase(),
        )
        const blockUnknown = modCfg.links.blockUnknownDomains
        const urls = parseUrls(text)
        for (const url of urls) {
            const domain = domainFromUrl(url)
            if (!domain) continue
            const allowed = allowlist.some((d) => domain.endsWith(d))
            if (blockUnknown && !allowed) {
                return await performAction(
                    message,
                    modCfg.spam?.action ?? "warn",
                    modCfg,
                    config,
                    actions,
                    `link ${domain}`,
                )
            }
        }
    }
}

async function performAction(message, action, modCfg, config, actions, reason) {
    const guild = message.guild
    const member = message.member
    const user = message.author
    const channel = message.channel
    const reasonText = reason ? ` (${reason})` : ""

    const dryRun = Boolean(modCfg.dryRun)

    async function maybeExecute(name, fn) {
        if (dryRun) {
            console.log(
                `[automod][dry-run] would ${name} user ${user.id} in guild ${
                    guild?.id
                }${reasonText ? ` for reason: ${reasonText}` : ""}`,
            )
            await auditLog(config, message.client, {
                actor: `${user.username} (${user.id})`,
                action: `automod.dryRun.${name}`,
                target: `${guild?.id ?? "unknown"}:${channel?.id ?? "unknown"}`,
                detail: reasonText,
            })
            return
        }
        return fn()
    }

    const doWarn = async () => {
        await maybeExecute("warn", async () => {
            await message.delete().catch(() => null)
            await channel.send({
                content: `${user} Please follow the server rules.${reasonText}`,
            })
        })
    }

    const doDelete = async () => {
        await maybeExecute("delete", async () => {
            await message.delete().catch(() => null)
        })
    }

    const doTimeout = async (seconds) => {
        await maybeExecute("timeout", async () => {
            if (!member?.moderatable) return
            await member
                .timeout(seconds * 1000, `Automod${reasonText}`)
                .catch(() => null)
        })
    }

    const doBan = async (days) => {
        await maybeExecute("ban", async () => {
            if (!guild) return
            await guild.members
                .ban(user.id, {
                    days: days ?? 0,
                    reason: `Automod${reasonText}`,
                })
                .catch(() => null)
        })
    }

    const doStrike = async () => {
        const strikeConfig = modCfg.strikes
        if (!strikeConfig?.enabled) return

        const strikes = await stateStore.addStrike(
            guild.id,
            user.id,
            60 * 60, // 1h TTL
        )

        const count = strikes?.count ?? 0
        const thresholds = strikeConfig.thresholds ?? {}
        const sorted = Object.keys(thresholds)
            .map((k) => parseInt(k, 10))
            .filter((n) => !Number.isNaN(n))
            .sort((a, b) => a - b)

        const applicable = sorted.filter((t) => count >= t)
        const threshold = applicable[applicable.length - 1]
        if (!threshold) return

        const rule = thresholds[String(threshold)]
        if (!rule) return

        const act = rule.action
        if (act === "warn") {
            await doWarn()
        } else if (act === "delete") {
            await doDelete()
        } else if (act === "timeout") {
            await doTimeout(rule.timeoutSeconds ?? 600)
        } else if (act === "ban") {
            await doBan(rule.deleteMessageDays ?? 0)
        }
    }

    // If a specific action was provided, use it. Otherwise use strikes.
    if (action) {
        if (action === "warn") return doWarn()
        if (action === "delete") return doDelete()
        if (action === "timeout")
            return doTimeout(modCfg.spam?.timeoutSeconds ?? 600)
        if (action === "ban") return doBan(modCfg.spam?.timeoutSeconds ?? 0)
    }

    // Fallback to strike logic
    return doStrike()
}
