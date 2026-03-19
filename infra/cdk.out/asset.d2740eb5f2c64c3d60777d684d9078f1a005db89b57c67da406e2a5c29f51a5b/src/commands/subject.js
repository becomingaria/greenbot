import { SlashCommandBuilder } from "@discordjs/builders"
import { ChannelType } from "discord.js"
import { auditLog } from "../audit.js"

export const data = new SlashCommandBuilder()
    .setName("subject")
    .setDescription("Manage subject categories and channels")
    .addSubcommand((sub) =>
        sub
            .setName("create")
            .setDescription("Create a subject (category) with default channels")
            .addStringOption((opt) =>
                opt
                    .setName("name")
                    .setDescription("Name of the subject/category")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("channels")
            .setDescription("Manage channels under a subject")
            .addStringOption((opt) =>
                opt
                    .setName("subject")
                    .setDescription("Subject (category) name or ID")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("name")
                    .setDescription("Channel name")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("type")
                    .setDescription("Channel type")
                    .setRequired(true)
                    .addChoices(
                        { name: "Text", value: "text" },
                        { name: "Voice", value: "voice" },
                        { name: "Forum", value: "forum" },
                    ),
            ),
    )

async function findCategory(guild, identifier) {
    if (!guild) return null

    const id = identifier.replace(/[^0-9]/g, "")
    if (id) {
        const byId = guild.channels.cache.get(id)
        if (byId && byId.isCategory()) return byId
    }

    return guild.channels.cache.find(
        (c) =>
            c.isCategory() && c.name.toLowerCase() === identifier.toLowerCase(),
    )
}

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const sub = interaction.options.getSubcommand()
    const config = context.configManager?.getCurrentConfig?.() ?? context.config
    const guild = interaction.guild

    if (!config || !guild) {
        await interaction.reply({
            content: "Missing config or guild context.",
            ephemeral: true,
        })
        return
    }

    if (!config.features?.subjects) {
        await interaction.reply({
            content: "Subjects are not enabled in config.",
            ephemeral: true,
        })
        return
    }

    if (sub === "create") {
        const name = interaction.options.getString("name", true).trim()
        const existing = guild.channels.cache.find(
            (c) =>
                c.isCategory() && c.name.toLowerCase() === name.toLowerCase(),
        )
        if (existing) {
            await interaction.reply({
                content: `Category "${name}" already exists.`,
                ephemeral: true,
            })
            return
        }

        const category = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
        })

        const defaults = config.subjects?.defaultChannels ?? []
        const created = []
        for (const def of defaults) {
            const channelType =
                def.type === "voice"
                    ? ChannelType.GuildVoice
                    : def.type === "forum"
                      ? ChannelType.GuildForum
                      : ChannelType.GuildText

            const channel = await guild.channels.create({
                name: def.name,
                type: channelType,
                parent: category,
            })
            if (def.locked) {
                await channel.permissionOverwrites.edit(guild.roles.everyone, {
                    SendMessages: false,
                    SendMessagesInThreads: false,
                })
            }
            created.push(channel.name)
        }

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "subject.create",
            target: name,
            detail: `created ${created.length} default channels`,
        })

        await interaction.reply({
            content: `Created subject category **${name}** with default channels: ${
                created.length ? created.join(", ") : "(none)"
            }`,
            ephemeral: true,
        })
        return
    }

    if (sub === "channels") {
        const subject = interaction.options.getString("subject", true)
        const name = interaction.options.getString("name", true)
        const type = interaction.options.getString("type", true)

        const category = await findCategory(guild, subject)
        if (!category) {
            await interaction.reply({
                content: `Could not find subject category '${subject}'.`,
                ephemeral: true,
            })
            return
        }

        const channelType =
            type === "voice"
                ? ChannelType.GuildVoice
                : type === "forum"
                  ? ChannelType.GuildForum
                  : ChannelType.GuildText
        const channel = await guild.channels.create({
            name,
            type: channelType,
            parent: category,
        })

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "subject.channels.add",
            target: channel.id,
            detail: `subject=${category.name}`,
        })

        await interaction.reply({
            content: `Created channel <#${channel.id}> under **${category.name}**.`,
            ephemeral: true,
        })
        return
    }
}
