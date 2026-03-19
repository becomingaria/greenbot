import { StateStore } from "./state.js"

const stateStore = new StateStore({
    tableName: process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
})

function getCooldownKey(ruleId, channelId, userId) {
    return `${ruleId}:${channelId}:${userId}`
}

export async function runQa(message, config) {
    if (!config.features?.qa) return
    if (!message.guild || message.author.bot) return

    const qaCfg = config.qa
    if (!qaCfg?.enabled) return

    const text = message.content || ""
    const channelId = message.channelId
    const userId = message.author.id

    for (const [index, rule] of (qaCfg.rules ?? []).entries()) {
        const mode = rule.mode || qaCfg.defaultMode || "contains"
        const trigger = rule.trigger
        if (!trigger) continue

        const matches = matchTrigger(text, trigger, mode)
        if (!matches) continue

        const channelFilter = rule.channelIds ?? []
        if (channelFilter.length && !channelFilter.includes(channelId)) continue

        const cooldownSec = rule.cooldownSeconds ?? 0
        const key = getCooldownKey(index, channelId, userId)
        const now = Date.now()
        const existing = await stateStore.getCooldown(index, channelId, userId)
        if (now < existing.expiresAt * 1000) return
        await stateStore.setCooldown(index, channelId, userId, cooldownSec)
        await message.channel.send({ content: rule.response })
        return
    }
}

function matchTrigger(text, trigger, mode) {
    if (!text || !trigger) return false
    const normalized = text.toLowerCase()
    if (mode === "exact") {
        return normalized.trim() === trigger.trim().toLowerCase()
    }
    if (mode === "regex") {
        try {
            const re = new RegExp(trigger, "i")
            return re.test(text)
        } catch {
            return false
        }
    }
    // default: contains
    return normalized.includes(trigger.toLowerCase())
}
