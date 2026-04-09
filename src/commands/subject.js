import { SlashCommandBuilder } from "@discordjs/builders"
import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js"
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
    .addSubcommand((sub) =>
        sub
            .setName("join")
            .setDescription("Join a subject by id/name (assign role to member)")
            .addStringOption((opt) =>
                opt
                    .setName("subject")
                    .setDescription("Subject name or category id")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("delete")
            .setDescription(
                "Delete a subject category, all its channels, and its role",
            )
            .addStringOption((opt) =>
                opt
                    .setName("name")
                    .setDescription("Name of the subject/category to delete")
                    .setRequired(true),
            ),
    )

async function findCategory(guild, identifier) {
    if (!guild) return null

    const id = identifier.replace(/[^0-9]/g, "")
    if (id) {
        const byId = guild.channels.cache.get(id)
        if (byId && byId.type === ChannelType.GuildCategory) return byId
    }

    return guild.channels.cache.find(
        (c) =>
            c.type === ChannelType.GuildCategory &&
            c.name.toLowerCase() === identifier.toLowerCase(),
    )
}

function roleNameForSubject(config, name) {
    const prefix = config.subjects?.rolePrefix ?? ""
    return `${prefix}${name}`.trim()
}

async function ensureSubjectRole(guild, roleName) {
    const existing = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleName.toLowerCase(),
    )
    if (existing) return existing

    return guild.roles.create({ name: roleName, mentionable: false })
}

async function setChannelPermissions(channel, role) {
    const everyone = channel.guild.roles.everyone

    const roleAllow = [PermissionFlagsBits.ViewChannel]
    const everyoneDeny = [PermissionFlagsBits.ViewChannel]

    if (channel.type === ChannelType.GuildVoice) {
        roleAllow.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak)
        everyoneDeny.push(
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
        )
    } else if (channel.type === ChannelType.GuildText) {
        roleAllow.push(
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads,
        )
        everyoneDeny.push(
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
        )
    }

    await channel.permissionOverwrites.set([
        { id: everyone.id, deny: everyoneDeny },
        { id: role.id, allow: roleAllow },
    ])
}

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const sub = interaction.options.getSubcommand()
    const config = context.configManager?.getCurrentConfig?.() ?? context.config
    const guild = interaction.guild

    if (!config || !guild) {
        await interaction.reply({
            content: "Missing config or guild context.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (!config.features?.subjects) {
        await interaction.reply({
            content: "Subjects are not enabled in config.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "create") {
        const name = interaction.options.getString("name", true).trim()
        const existing = guild.channels.cache.find(
            (c) =>
                c.type === ChannelType.GuildCategory &&
                c.name.toLowerCase() === name.toLowerCase(),
        )
        if (existing) {
            await interaction.reply({
                content: `Category "${name}" already exists.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const category = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
        })

        const roleName = roleNameForSubject(config, name)
        const role = await ensureSubjectRole(guild, roleName)

        const defaults = config.subjects?.defaultChannels ?? []
        const created = []
        for (const def of defaults) {
            const channelType =
                def.type === "voice"
                    ? ChannelType.GuildVoice
                    : def.type === "forum"
                      ? ChannelType.GuildForum
                      : ChannelType.GuildText

            const channelName = def.name.replace(/\{subject\}/gi, name)

            const channel = await guild.channels.create({
                name: channelName,
                type: channelType,
                parent: category,
            })

            // Apply restricted permissions out of the box (private subject behavior).
            await setChannelPermissions(channel, role)

            // On top of role restrictions, if locked is set we ensure no one without role can send.
            if (def.locked && channel.type === ChannelType.GuildText) {
                await channel.permissionOverwrites.edit(role, {
                    deny: [PermissionFlagsBits.SendMessages],
                })
            }

            created.push(channel.name)
        }

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.username} (${interaction.user.id})`,
            action: "subject.create",
            target: name,
            detail: `created ${created.length} default channels + role ${role.name}`,
        })

        await interaction.reply({
            content: `Created subject category **${name}** + role **${role.name}** with default channels: ${
                created.length ? created.join(", ") : "(none)"
            }`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "join") {
        const subject = interaction.options.getString("subject", true)
        const category = await findCategory(guild, subject)
        if (!category) {
            await interaction.reply({
                content: `Could not find subject category '${subject}'.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const roleName = roleNameForSubject(config, category.name)
        const role = guild.roles.cache.find(
            (r) => r.name.toLowerCase() === roleName.toLowerCase(),
        )
        if (!role) {
            await interaction.reply({
                content: `No role found for subject '${category.name}' (expected '${roleName}').`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const member = interaction.member
        if (!member) {
            await interaction.reply({
                content: "Could not resolve member.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        await member.roles.add(role)

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.username} (${interaction.user.id})`,
            action: "subject.join",
            target: `${category.name}`,
            detail: `member added role ${role.name}`,
        })

        await interaction.reply({
            content: `You have been added to **${role.name}** and can now access subject **${category.name}**.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "delete") {
        const name = interaction.options.getString("name", true).trim()
        const category = await findCategory(guild, name)
        if (!category) {
            await interaction.reply({
                content: `No subject category found matching '${name}'.`,
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        // Delete all child channels
        const children = guild.channels.cache.filter(
            (c) => c.parentId === category.id,
        )
        const deletedChannels = []
        for (const [, child] of children) {
            deletedChannels.push(child.name)
            await child.delete()
        }
        await category.delete()

        // Delete the associated role if it exists
        const roleName = roleNameForSubject(config, category.name)
        const role = guild.roles.cache.find(
            (r) => r.name.toLowerCase() === roleName.toLowerCase(),
        )
        if (role) await role.delete()

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.username} (${interaction.user.id})`,
            action: "subject.delete",
            target: name,
            detail: `deleted ${deletedChannels.length} channels + role ${role?.name ?? "(none)"}`,
        })

        await interaction.reply({
            content: `Deleted subject **${name}**: removed ${deletedChannels.length} channel(s)${
                role ? ` and role **${role.name}**` : ""
            }.`,
            flags: MessageFlags.Ephemeral,
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
                flags: MessageFlags.Ephemeral,
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
            actor: `${interaction.user.username} (${interaction.user.id})`,
            action: "subject.channels.add",
            target: channel.id,
            detail: `subject=${category.name}`,
        })

        await interaction.reply({
            content: `Created channel <#${channel.id}> under **${category.name}**.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }
}
