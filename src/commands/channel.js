import { SlashCommandBuilder } from "@discordjs/builders"
import { ChannelType, PermissionsBitField } from "discord.js"
import { auditLog } from "../audit.js"


export const data = new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Channel management commands")
    .addSubcommand((sub) =>
        sub
            .setName("archive")
            .setDescription(
                "Archive a channel (move to archive category and lock it).",
            )
            .addChannelOption((opt) =>
                opt
                    .setName("channel")
                    .setDescription("Channel to archive")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt.setName("reason").setDescription("Reason for archiving"),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("delete")
            .setDescription("Delete a channel (requires confirm).")
            .addChannelOption((opt) =>
                opt
                    .setName("channel")
                    .setDescription("Channel to delete")
                    .setRequired(true),
            )
            .addBooleanOption((opt) =>
                opt
                    .setName("confirm")
                    .setDescription("Set to true to confirm deletion."),
            )
            .addStringOption((opt) =>
                opt.setName("reason").setDescription("Reason for deletion"),
            ),
    )

function getArchiveCategoryId(config) {
    return config.subjects?.archiveCategoryId || null
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


    if (!config.features?.archive) {
        await interaction.reply({
            content: "Archive features are not enabled in config.",
            ephemeral: true,
        })
        return
    }

    const archiveCategoryId = getArchiveCategoryId(config)
    if (!archiveCategoryId) {
        await interaction.reply({
            content:
                "No archive category configured (subjects.archiveCategoryId). Please set it in config.",
            ephemeral: true,
        })
        return
    }

    const target = interaction.options.getChannel("channel", true)
    if (!target) {
        await interaction.reply({
            content: "Channel not found.",
            ephemeral: true,
        })
        return
    }

    if (sub === "archive") {
        const reason = interaction.options.getString("reason") ?? ""

        const archiveCategory = guild.channels.cache.get(archiveCategoryId)
        if (
            !archiveCategory ||
            archiveCategory.type !== ChannelType.GuildCategory
        ) {
            await interaction.reply({
                content:
                    "Archive category not found or is not a category. Check subjects.archiveCategoryId.",
                ephemeral: true,
            })
            return
        }

        await target.edit({ parent: archiveCategoryId })

        // lock it down
        await target.permissionOverwrites.edit(guild.roles.everyone, {
            SendMessages: false,
            SendMessagesInThreads: false,
        })

        const prefix = config.subjects?.archiveRenamePrefix ?? "archived-"
        const newName = `${prefix}${target.name}`
        await target.setName(newName).catch(() => null)

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "channel.archive",
            target: target.id,
            detail: `reason=${reason}`,
        })

        await interaction.reply({
            content: `Archived channel <#${target.id}> (reason: ${reason || "none"}).`,
            ephemeral: true,
        })
        return
    }

    if (sub === "delete") {
        const confirm = interaction.options.getBoolean("confirm")
        const reason = interaction.options.getString("reason") ?? ""

        if (!confirm) {
            await interaction.reply({
                content:
                    "Please confirm deletion by setting `confirm` to true. This action is irreversible.",
                ephemeral: true,
            })
            return
        }

        await target.delete(reason).catch((err) => {
            console.error(err)
        })

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "channel.delete",
            target: target.id,
            detail: `reason=${reason}`,
        })

        await interaction.reply({
            content: `Deleted channel ${target.name} (reason: ${reason || "none"}).`,
            ephemeral: true,
        })
        return
    }
}
