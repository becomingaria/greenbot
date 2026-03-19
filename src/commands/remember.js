import { SlashCommandBuilder } from "@discordjs/builders"
import yaml from "yaml"
import { StateStore } from "../state.js"

const stateStore = new StateStore({
    tableName: process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
})

function unixSeconds() {
    return Math.floor(Date.now() / 1000)
}

function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const parts = []
    if (days) parts.push(`${days}d`)
    if (hours) parts.push(`${hours}h`)
    if (mins) parts.push(`${mins}m`)
    return parts.length ? parts.join(" ") : `${seconds}s`
}

export const data = new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Remember small pieces of information for the server.")
    .addSubcommand((sub) =>
        sub
            .setName("set")
            .setDescription("Store a key/value pair for later.")
            .addStringOption((opt) =>
                opt
                    .setName("key")
                    .setDescription("Key to remember")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("value")
                    .setDescription("Value to store")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("get")
            .setDescription("Retrieve a remembered value.")
            .addStringOption((opt) =>
                opt
                    .setName("key")
                    .setDescription("Key to retrieve")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("delete")
            .setDescription("Forget a remembered key.")
            .addStringOption((opt) =>
                opt
                    .setName("key")
                    .setDescription("Key to forget")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub.setName("list").setDescription("List remembered keys."),
    )
    .addSubcommand((sub) =>
        sub
            .setName("export")
            .setDescription("Export remembered keys as a YAML file."),
    )

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const config = context.configManager?.getCurrentConfig?.() ?? context.config
    if (!config) {
        await interaction.reply({
            content: "Config is not loaded yet.",
            ephemeral: true,
        })
        return
    }

    if (!config.features?.remember) {
        await interaction.reply({
            content:
                "The remember feature is not enabled in this server's configuration.",
            ephemeral: true,
        })
        return
    }

    const guild = interaction.guild
    if (!guild) {
        await interaction.reply({
            content: "This command can only be used in a server.",
            ephemeral: true,
        })
        return
    }

    const forgetDays = config.remember?.forgetAfterDays ?? 30
    const ttlSeconds = forgetDays * 24 * 60 * 60

    const sub = interaction.options.getSubcommand()
    if (sub === "set") {
        const key = interaction.options.getString("key", true).trim()
        const value = interaction.options.getString("value", true)

        await stateStore.setRemember(guild.id, key, value, ttlSeconds)
        await interaction.reply({
            content: `Remembered **${key}** for ${forgetDays} days.`,
            ephemeral: true,
        })
        return
    }

    if (sub === "get") {
        const key = interaction.options.getString("key", true).trim()
        const item = await stateStore.getRemember(guild.id, key)
        if (!item) {
            await interaction.reply({
                content: `No remembered value found for **${key}**.`,
                ephemeral: true,
            })
            return
        }

        await stateStore.touchRemember(guild.id, key, ttlSeconds)
        const expiresIn = Math.max(0, item.expiresAt - unixSeconds())
        await interaction.reply({
            content: `**${key}** = ${item.value}
Expires in ${formatDuration(expiresIn)} (accessing extends the lifetime).`,
            ephemeral: true,
        })
        return
    }

    if (sub === "delete") {
        const key = interaction.options.getString("key", true).trim()
        const removed = await stateStore.deleteRemember(guild.id, key)
        await interaction.reply({
            content: removed
                ? `Forgot **${key}**.`
                : `No remembered value found for **${key}**.`,
            ephemeral: true,
        })
        return
    }

    if (sub === "list") {
        const items = await stateStore.listRemembers(guild.id)
        if (!items || !items.length) {
            await interaction.reply({
                content: "No remembered keys found.",
                ephemeral: true,
            })
            return
        }

        const now = unixSeconds()
        const lines = items.slice(0, 25).map((item) => {
            const expiresIn = Math.max(0, item.expiresAt - now)
            return `• **${item.key}** (expires in ${formatDuration(expiresIn)})`
        })

        const more =
            items.length > 25
                ? `
…and ${items.length - 25} more items.`
                : ""

        await interaction.reply({
            content: `Remembered keys:\n${lines.join("\n")}${more}`,
            ephemeral: true,
        })
        return
    }

    if (sub === "export") {
        const items = await stateStore.listReminders(guild.id)
        if (!items || !items.length) {
            await interaction.reply({
                content: "No remembered keys found.",
                ephemeral: true,
            })
            return
        }

        const payload = {}
        for (const item of items) {
            payload[item.key] = {
                value: item.value,
                expiresAt: item.expiresAt,
                lastAccessed: item.lastAccessed,
                recurrence: item.recurrence,
            }
        }

        const yamlPayload = yaml.stringify(payload)
        const fileName = `remembered-${guild.id}.yaml`

        await interaction.reply({
            content: "Here is your remembered data.",
            files: [
                {
                    attachment: Buffer.from(yamlPayload, "utf8"),
                    name: fileName,
                },
            ],
            ephemeral: true,
        })
        return
    }
}
