import { SlashCommandBuilder } from "@discordjs/builders"
import { MessageFlags } from "discord.js"

import { StateStore } from "../state.js"
import { parseReminderSchedule, computeNextReminderDue } from "../reminders.js"

const stateStore = new StateStore({
    tableName: process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
})

function unixSeconds() {
    return Math.floor(Date.now() / 1000)
}

function formatAt(seconds) {
    const date = new Date(seconds * 1000)
    return date.toISOString().replace("T", " ").replace("Z", "")
}

export const data = new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Schedule a reminder for yourself or a channel.")
    .addSubcommand((sub) =>
        sub
            .setName("create")
            .setDescription("Create a new reminder.")
            .addStringOption((opt) =>
                opt
                    .setName("when")
                    .setDescription(
                        "Time to trigger (e.g. 10m, 2h, 1d, or ISO timestamp).",
                    )
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("message")
                    .setDescription("Reminder message")
                    .setRequired(true),
            )
            .addChannelOption((opt) =>
                opt
                    .setName("channel")
                    .setDescription(
                        "Channel to send the reminder in (default is current channel).",
                    ),
            ),
    )
    .addSubcommand((sub) =>
        sub.setName("list").setDescription("List your upcoming reminders."),
    )
    .addSubcommand((sub) =>
        sub
            .setName("cancel")
            .setDescription("Cancel a reminder by ID.")
            .addStringOption((opt) =>
                opt
                    .setName("id")
                    .setDescription("Reminder ID from /remind list")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("snooze")
            .setDescription("Snooze a reminder for a duration.")
            .addStringOption((opt) =>
                opt
                    .setName("id")
                    .setDescription("Reminder ID from /remind list")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("duration")
                    .setDescription("Amount to snooze (e.g. 10m, 2h, 1d)")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("show")
            .setDescription("Show details for a single reminder by ID.")
            .addStringOption((opt) =>
                opt
                    .setName("id")
                    .setDescription("Reminder ID from /remind list")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("clone")
            .setDescription("Clone an existing reminder.")
            .addStringOption((opt) =>
                opt
                    .setName("id")
                    .setDescription("Reminder ID from /remind list")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("edit")
            .setDescription("Edit an existing reminder.")
            .addStringOption((opt) =>
                opt
                    .setName("id")
                    .setDescription("Reminder ID from /remind list")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("when")
                    .setDescription("New time (supports natural language/cron)")
                    .setRequired(false),
            )
            .addStringOption((opt) =>
                opt
                    .setName("message")
                    .setDescription("New reminder message")
                    .setRequired(false),
            )
            .addStringOption((opt) =>
                opt
                    .setName("recurrence")
                    .setDescription(
                        "Optional recurrence expression (e.g. every Monday at 9am)",
                    )
                    .setRequired(false),
            ),
    )

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const config = context.configManager?.getCurrentConfig?.() ?? context.config
    if (!config) {
        await interaction.reply({
            content: "Config is not loaded yet.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (!config.features?.reminders) {
        await interaction.reply({
            content:
                "The reminders feature is not enabled in this server's configuration.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const guild = interaction.guild
    if (!guild) {
        await interaction.reply({
            content: "This command can only be used in a server.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const sub = interaction.options.getSubcommand()

    if (sub === "create") {
        const when = interaction.options.getString("when", true)
        const message = interaction.options.getString("message", true)
        const channel = interaction.options.getChannel("channel")

        const parsed = parseReminderSchedule(when)
        if (!parsed || !parsed.dueAt || parsed.dueAt <= unixSeconds()) {
            await interaction.reply({
                content:
                    "Could not parse the time. Use a relative duration (e.g. 10m, 2h, 1d), an ISO timestamp in the future, or a cron-style expression.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const targetChannelId = channel?.id ?? interaction.channelId
        const keepDays = config.reminders?.keepSentDays ?? 7

        const { reminderId } = await stateStore.addReminder(
            guild.id,
            targetChannelId,
            interaction.user.id,
            message,
            parsed.dueAt,
            keepDays,
            { recurrence: parsed.recurrence },
        )

        await interaction.reply({
            content: `Reminder scheduled for **${formatAt(parsed.dueAt)}** in <#${targetChannelId}> (ID: ${reminderId}).${parsed.recurrence ? ` Recurs: ${parsed.recurrence}` : ""}`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "list") {
        const items = await stateStore.listReminders(
            guild.id,
            interaction.user.id,
        )
        if (!items || !items.length) {
            await interaction.reply({
                content: "You have no upcoming reminders.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const lines = items.slice(0, 25).map((it) => {
            const due = formatAt(it.dueAt)
            const recurrence = it.recurrence
                ? ` (recurs: ${it.recurrence})`
                : ""
            return `• ID: \`${it.reminderId}\` - ${due}${recurrence} - ${it.message}`
        })

        const more =
            items.length > 25 ? `\n…and ${items.length - 25} more.` : ""

        await interaction.reply({
            content: `Your reminders:\n${lines.join("\n")}${more}`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "cancel") {
        const id = interaction.options.getString("id", true)
        const success = await stateStore.deleteReminder(guild.id, id)
        await interaction.reply({
            content: success
                ? `Cancelled reminder ${id}.`
                : `Could not find a reminder with ID ${id}.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "snooze") {
        const id = interaction.options.getString("id", true)
        const duration = interaction.options.getString("duration", true)

        const existing = await stateStore.getReminder(guild.id, id)
        if (!existing) {
            await interaction.reply({
                content: `Could not find a reminder with ID ${id}.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const parsed = parseReminderSchedule(duration)
        if (!parsed || !parsed.dueAt || parsed.dueAt <= unixSeconds()) {
            await interaction.reply({
                content:
                    "Could not parse the snooze duration. Use something like '10m', '2h', or '1d'.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const now = unixSeconds()
        const offset = parsed.dueAt - now
        if (offset <= 0) {
            await interaction.reply({
                content: "Snooze duration must be in the future.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const keepDays = config.reminders?.keepSentDays ?? 7
        const newDue = existing.dueAt + offset

        await stateStore.updateReminder(guild.id, id, {
            dueAt: newDue,
            sent: false,
            keepDays,
        })

        await interaction.reply({
            content: `Snoozed reminder ${id} by ${duration}. New time: ${formatAt(
                newDue,
            )}`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "show") {
        const id = interaction.options.getString("id", true)
        const reminder = await stateStore.getReminder(guild.id, id)
        if (!reminder) {
            await interaction.reply({
                content: `Could not find a reminder with ID ${id}.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const lines = []
        lines.push(`**ID:** ${reminder.reminderId}`)
        lines.push(`**Message:** ${reminder.message}`)
        lines.push(`**Due:** ${formatAt(reminder.dueAt)}`)
        if (reminder.recurrence)
            lines.push(`**Recurrence:** ${reminder.recurrence}`)
        if (reminder.channelId)
            lines.push(`**Channel:** <#${reminder.channelId}>`)
        if (reminder.userId) lines.push(`**Created by:** <@${reminder.userId}>`)

        await interaction.reply({
            content: lines.join("\n"),
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "clone") {
        const id = interaction.options.getString("id", true)
        const existing = await stateStore.getReminder(guild.id, id)
        if (!existing) {
            await interaction.reply({
                content: `Could not find a reminder with ID ${id}.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        // Clone the reminder with a fresh ID, keeping the same due time and recurrence.
        const keepDays = config.reminders?.keepSentDays ?? 7
        const { reminderId: newId } = await stateStore.addReminder(
            guild.id,
            existing.channelId,
            existing.userId,
            existing.message,
            existing.dueAt,
            keepDays,
            { recurrence: existing.recurrence },
        )

        await interaction.reply({
            content: `Cloned reminder ${id} to new reminder ${newId}.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "edit") {
        const id = interaction.options.getString("id", true)
        const when = interaction.options.getString("when")
        const message = interaction.options.getString("message")
        const recurrence = interaction.options.getString("recurrence")

        const existing = await stateStore.getReminder(guild.id, id)
        if (!existing) {
            await interaction.reply({
                content: `Could not find a reminder with ID ${id}.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const updates = {}
        if (message) updates.message = message

        if (when) {
            const parsed = parseReminderSchedule(when)
            if (!parsed || !parsed.dueAt || parsed.dueAt <= unixSeconds()) {
                await interaction.reply({
                    content:
                        "Could not parse the new time. Use a relative duration (e.g. 10m, 2h, 1d), an ISO timestamp in the future, or a cron-style expression.",
                    flags: MessageFlags.Ephemeral,
                })
                return
            }
            updates.dueAt = parsed.dueAt
            updates.recurrence = parsed.recurrence
        }

        if (recurrence) {
            const next = computeNextReminderDue(recurrence, unixSeconds())
            if (!next) {
                await interaction.reply({
                    content:
                        "Could not parse the recurrence expression. Use cron, 'every Monday at 9am', or 'every 1h'.",
                    flags: MessageFlags.Ephemeral,
                })
                return
            }
            updates.recurrence = recurrence
            updates.dueAt = next
        }

        if (!Object.keys(updates).length) {
            await interaction.reply({
                content:
                    "No changes provided. Specify --when, --message, or --recurrence.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const keepDays = config.reminders?.keepSentDays ?? 7
        updates.keepDays = keepDays
        updates.sent = false

        await stateStore.updateReminder(guild.id, id, updates)

        await interaction.reply({
            content: `Updated reminder ${id}.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }
}
