import * as chrono from "chrono-node"
import cronParser from "cron-parser"
import { StateStore } from "./state.js"
import { auditLog } from "./audit.js"

const stateStore = new StateStore({
    tableName: process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
})

function unixSeconds() {
    return Math.floor(Date.now() / 1000)
}

function parseDuration(input) {
    const match = String(input)
        .trim()
        .match(/^\s*(\d+)\s*(s|m|h|d|w)\s*$/i)
    if (!match) return null
    const value = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()
    if (Number.isNaN(value)) return null
    if (unit === "s") return value
    if (unit === "m") return value * 60
    if (unit === "h") return value * 60 * 60
    if (unit === "d") return value * 24 * 60 * 60
    if (unit === "w") return value * 7 * 24 * 60 * 60
    return null
}

function addBusinessDays(date, businessDays) {
    const result = new Date(date)
    let added = 0
    while (added < businessDays) {
        result.setDate(result.getDate() + 1)
        const day = result.getDay()
        if (day !== 0 && day !== 6) {
            added += 1
        }
    }
    return result
}

function parseWhen(input, now = unixSeconds()) {
    if (!input) return null
    const txt = String(input).trim()

    // Cron-like schedule: "cron:*/5 * * * *" or plain "*/5 * * * *"
    const cronExpr = txt.replace(/^cron:\s*/i, "").trim()
    const isCron =
        /^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))$/i.test(
            cronExpr,
        ) || /^([\d\*\/\-,]+\s+){4}[\d\*\/\-,]+$/.test(cronExpr)
    if (isCron) {
        try {
            const interval = cronParser.parseExpression(cronExpr, {
                currentDate: new Date(now * 1000),
            })
            const next = interval.next().getTime() / 1000
            return { dueAt: Math.floor(next), recurrence: cronExpr }
        } catch {
            // fall through
        }
    }

    // Natural language: "in 10 minutes", "in 2h", "tomorrow at 10:00".
    const inMatch = txt.match(
        /^in\s+(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?)$/i,
    )
    if (inMatch) {
        const value = parseInt(inMatch[1], 10)
        const unit = inMatch[2].toLowerCase()
        let seconds = 0
        if (unit.startsWith("second")) seconds = value
        else if (unit.startsWith("minute")) seconds = value * 60
        else if (unit.startsWith("hour")) seconds = value * 60 * 60
        else if (unit.startsWith("day")) seconds = value * 24 * 60 * 60
        else if (unit.startsWith("week")) seconds = value * 7 * 24 * 60 * 60
        if (seconds > 0) {
            return { dueAt: now + seconds, recurrence: null }
        }
    }

    // Business days: "in 3 business days"
    const bizMatch = txt.match(/^in\s+(\d+)\s*(business\s+days|bdays?)$/i)
    if (bizMatch) {
        const value = parseInt(bizMatch[1], 10)
        if (!Number.isNaN(value) && value > 0) {
            const dueDate = addBusinessDays(new Date(now * 1000), value)
            return {
                dueAt: Math.floor(dueDate.getTime() / 1000),
                recurrence: null,
            }
        }
    }

    const duration = parseDuration(txt)
    if (duration !== null) {
        return { dueAt: now + duration, recurrence: null }
    }

    // Natural language via chrono-node (e.g. "next Friday", "tomorrow at 9am")
    try {
        const chronoDate = chrono.parseDate(txt, new Date(now * 1000))
        if (chronoDate) {
            const dueAt = Math.floor(chronoDate.getTime() / 1000)
            if (dueAt > now) {
                return { dueAt, recurrence: null }
            }
        }
    } catch {
        // fallback to other methods
    }

    // "tomorrow at HH:MM" or "today at HH:MM".
    const dayAtMatch = txt.match(/^(today|tomorrow)\s+at\s+(\d{1,2}):(\d{2})$/i)
    if (dayAtMatch) {
        const day = dayAtMatch[1].toLowerCase()
        const hour = parseInt(dayAtMatch[2], 10)
        const minute = parseInt(dayAtMatch[3], 10)
        const date = new Date(now * 1000)
        if (day === "tomorrow") date.setDate(date.getDate() + 1)
        date.setHours(hour, minute, 0, 0)
        const dueAt = Math.floor(date.getTime() / 1000)
        if (dueAt > now) {
            return { dueAt, recurrence: null }
        }
    }

    const parsed = Date.parse(txt)
    if (!Number.isNaN(parsed)) {
        const dueAt = Math.floor(parsed / 1000)
        if (dueAt > now) {
            return { dueAt, recurrence: null }
        }
    }

    return null
}

function computeNextDueFromRecurrence(recurrence, after) {
    if (!recurrence) return null
    const now = after || unixSeconds()

    // Cron-like case
    const cronExpr = String(recurrence)
        .replace(/^cron:\s*/i, "")
        .trim()
    const isCron =
        /^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))$/i.test(
            cronExpr,
        ) || /^([\d\*\/\-,]+\s+){4}[\d\*\/\-,]+$/.test(cronExpr)
    if (isCron) {
        try {
            const interval = cronParser.parseExpression(cronExpr, {
                currentDate: new Date(now * 1000),
            })
            return Math.floor(interval.next().getTime() / 1000)
        } catch {
            return null
        }
    }

    // Simple repeat interval: "every 1h", "every 10m", "every 1d".
    const everyMatch = String(recurrence)
        .trim()
        .match(/^every\s+(\d+)\s*(s|m|h|d|w)$/i)
    if (everyMatch) {
        const amount = parseInt(everyMatch[1], 10)
        const unit = everyMatch[2].toLowerCase()
        const seconds = parseDuration(`${amount}${unit}`)
        if (seconds) {
            return now + seconds
        }
    }

    // Daily at time: "every day at HH:MM".
    const dailyMatch = String(recurrence)
        .trim()
        .match(/^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/i)
    if (dailyMatch) {
        const hour = parseInt(dailyMatch[1], 10)
        const minute = parseInt(dailyMatch[2], 10)
        const current = new Date(now * 1000)
        const candidate = new Date(current)
        candidate.setHours(hour, minute, 0, 0)
        if (candidate.getTime() / 1000 <= now) {
            candidate.setDate(candidate.getDate() + 1)
        }
        return Math.floor(candidate.getTime() / 1000)
    }

    // Weekly on a day: "every Monday at HH:MM" or "every weekday at HH:MM".
    const weekdayMatch = String(recurrence)
        .trim()
        .match(
            /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday)\s+at\s+(\d{1,2}):(\d{2})$/i,
        )
    if (weekdayMatch) {
        const dayName = weekdayMatch[1].toLowerCase()
        const hour = parseInt(weekdayMatch[2], 10)
        const minute = parseInt(weekdayMatch[3], 10)
        const current = new Date(now * 1000)

        const dayMap = {
            sunday: 0,
            monday: 1,
            tuesday: 2,
            wednesday: 3,
            thursday: 4,
            friday: 5,
            saturday: 6,
        }

        const targetDays =
            dayName === "weekday" ? [1, 2, 3, 4, 5] : [dayMap[dayName] ?? 1]

        const candidate = new Date(current)
        candidate.setHours(hour, minute, 0, 0)

        for (let i = 0; i < 14; i++) {
            const day = candidate.getDay()
            if (targetDays.includes(day) && candidate.getTime() / 1000 > now) {
                return Math.floor(candidate.getTime() / 1000)
            }
            candidate.setDate(candidate.getDate() + 1)
        }
    }

    return null
}

export function startMaintenance(client, configManager) {
    // Run immediately and then on an interval.
    runMaintenance(client, configManager).catch(console.error)
    const intervalMs = 60 * 1000
    setInterval(() => {
        runMaintenance(client, configManager).catch(console.error)
    }, intervalMs)
}

export function parseReminderSchedule(input, now = unixSeconds()) {
    return parseWhen(input, now)
}

export function computeNextReminderDue(recurrence, after = unixSeconds()) {
    return computeNextDueFromRecurrence(recurrence, after)
}

async function runMaintenance(client, configManager) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const config = await configManager.getConfig(guild.id)
            if (config.features?.reminders) {
                await processRemindersForGuild(client, guild, config)
            }
            if (config.features?.remember) {
                await processRememberWarnings(client, guild, config)
            }
        } catch (err) {
            console.error(`Maintenance error for guild ${guild.id}:`, err)
        }
    }
}

async function processRemindersForGuild(client, guild, config) {
    const now = unixSeconds()
    const due = await stateStore.getDueReminders(guild.id, now)
    if (!due?.length) return

    const adminChannelId = config.admin?.controlChannelId
    for (const reminder of due) {
        const channelId = reminder.channelId || adminChannelId
        if (!channelId) continue

        const channel = await client.channels.fetch(channelId).catch(() => null)
        if (!channel || !channel.isTextBased()) continue

        const mention = reminder.userId ? `<@${reminder.userId}> ` : ""
        await channel
            .send({
                content: `${mention}Reminder: ${reminder.message}`,
            })
            .catch(() => null)

        if (reminder.recurrence) {
            const nextDue = computeNextDueFromRecurrence(
                reminder.recurrence,
                now,
            )
            if (nextDue) {
                await stateStore.updateReminder(guild.id, reminder.reminderId, {
                    dueAt: nextDue,
                    sent: false,
                    keepDays: config.reminders?.keepSentDays ?? 7,
                })
            } else {
                // Unable to compute next occurrence; cleanup.
                await stateStore.deleteReminder(guild.id, reminder.reminderId)
            }
        } else {
            await stateStore.deleteReminder(guild.id, reminder.reminderId)
        }

        await auditLog(config, client, {
            actor: `reminder-system`,
            action: "reminder.sent",
            target: `${guild.id}:${reminder.reminderId}`,
            detail: `Sent reminder to ${channelId}`,
        })
    }
}

async function processRememberWarnings(client, guild, config) {
    const adminChannelId = config.admin?.controlChannelId
    if (!adminChannelId) return

    const warnDays = config.remember?.warnBeforeDays ?? 10
    const forgetDays = config.remember?.forgetAfterDays ?? 30

    const warnBeforeSeconds = warnDays * 24 * 60 * 60
    const now = unixSeconds()

    const items = await stateStore.getRememberWarnings(
        guild.id,
        warnBeforeSeconds,
    )
    if (!items?.length) return

    const channel = await client.channels
        .fetch(adminChannelId)
        .catch(() => null)
    if (!channel || !channel.isTextBased()) return

    for (const item of items) {
        const timeLeft = item.expiresAt - now
        const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60))
        await channel
            .send({
                content: `Remembered item **${item.key}** will be forgotten in about ${daysLeft} day(s) unless it is accessed. Use \`/remember get ${item.key}\` to keep it alive.`,
            })
            .catch(() => null)

        await stateStore.markRememberWarned(guild.id, item.key)

        await auditLog(config, client, {
            actor: "remember-system",
            action: "remember.warning",
            target: `${guild.id}:${item.key}`,
            detail: `Will forget in ${daysLeft} days (forgetAfterDays=${forgetDays})`,
        })
    }
}
