import { SlashCommandBuilder } from "@discordjs/builders"
import { PermissionsBitField } from "discord.js"
import { auditLog } from "../audit.js"
import { requireAdmin, ensureAdminChannel } from "../utils.js"

export const data = new SlashCommandBuilder()
    .setName("mod")
    .setDescription("Moderation commands")
    .addSubcommand((sub) =>
        sub
            .setName("ban")
            .setDescription("Ban a user.")
            .addUserOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("User to ban")
                    .setRequired(true),
            )
            .addIntegerOption((opt) =>
                opt
                    .setName("delete_days")
                    .setDescription("Days of messages to delete (0-7)")
                    .setRequired(false),
            )
            .addStringOption((opt) =>
                opt.setName("reason").setDescription("Reason for ban"),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("unban")
            .setDescription("Unban a user by ID.")
            .addStringOption((opt) =>
                opt
                    .setName("user_id")
                    .setDescription("ID of the user to unban")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt.setName("reason").setDescription("Reason for unban"),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("role")
            .setDescription("Manage roles for a user.")
            .addStringOption((opt) =>
                opt
                    .setName("action")
                    .setDescription("add or remove")
                    .setRequired(true)
                    .addChoices(
                        { name: "add", value: "add" },
                        { name: "remove", value: "remove" },
                    ),
            )
            .addUserOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("User to modify")
                    .setRequired(true),
            )
            .addRoleOption((opt) =>
                opt
                    .setName("role")
                    .setDescription("Role to add/remove")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt.setName("reason").setDescription("Reason"),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("timeout")
            .setDescription("Timeout a user for a duration.")
            .addUserOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("User to timeout")
                    .setRequired(true),
            )
            .addIntegerOption((opt) =>
                opt
                    .setName("seconds")
                    .setDescription("Duration in seconds")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt.setName("reason").setDescription("Reason"),
            ),
    )

function formatReason(interaction, extra) {
    const user = interaction.user
    return `${extra || ""} (by ${user.tag} / ${user.id})`.trim()
}

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const config = context.configManager?.getCurrentConfig?.() ?? context.config
    const guild = interaction.guild
    if (!config || !guild) {
        await interaction.reply({
            content: "Missing config or guild context.",
            ephemeral: true,
        })
        return
    }

    if (!ensureAdminChannel(interaction, config)) return
    if (!requireAdmin(interaction, config)) return

    const sub = interaction.options.getSubcommand()
    const member = interaction.member
    if (!member) {
        await interaction.reply({
            content: "Could not resolve your guild member.",
            ephemeral: true,
        })
        return
    }

    const requiredPerms = {
        ban: PermissionsBitField.Flags.BanMembers,
        unban: PermissionsBitField.Flags.BanMembers,
        role: PermissionsBitField.Flags.ManageRoles,
        timeout: PermissionsBitField.Flags.ModerateMembers,
    }

    const required = requiredPerms[sub]
    if (required && !member.permissions.has(required)) {
        await interaction.reply({
            content: "You do not have permission to perform this action.",
            ephemeral: true,
        })
        return
    }

    if (sub === "ban") {
        const user = interaction.options.getUser("user", true)
        const deleteDays = interaction.options.getInteger("delete_days") ?? 0
        const reason = formatReason(
            interaction,
            interaction.options.getString("reason"),
        )

        await guild.members
            .ban(user.id, { days: deleteDays, reason })
            .catch((error) => {
                console.error(error)
            })

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "mod.ban",
            target: `${user.tag} (${user.id})`,
            detail: `deleteDays=${deleteDays}`,
        })

        await interaction.reply({
            content: `Banned ${user.tag} (${user.id}).`,
            ephemeral: true,
        })
        return
    }

    if (sub === "unban") {
        const userId = interaction.options.getString("user_id", true)
        const reason = formatReason(
            interaction,
            interaction.options.getString("reason"),
        )

        await guild.bans.remove(userId, reason).catch((error) => {
            console.error(error)
        })

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "mod.unban",
            target: userId,
            detail: reason,
        })

        await interaction.reply({
            content: `Unbanned user ${userId}.`,
            ephemeral: true,
        })
        return
    }

    if (sub === "role") {
        const action = interaction.options.getString("action", true)
        const user = interaction.options.getUser("user", true)
        const role = interaction.options.getRole("role", true)
        const reason = formatReason(
            interaction,
            interaction.options.getString("reason"),
        )

        const memberToUpdate = await guild.members
            .fetch(user.id)
            .catch(() => null)
        if (!memberToUpdate) {
            await interaction.reply({
                content: "Could not find that member.",
                ephemeral: true,
            })
            return
        }

        if (action === "add") {
            await memberToUpdate.roles.add(role, reason).catch((err) => {
                console.error(err)
            })

            await auditLog(config, interaction.client, {
                actor: `${interaction.user.tag} (${interaction.user.id})`,
                action: "mod.role.add",
                target: `${user.tag} (${user.id})`,
                detail: `role=${role.name}`,
            })

            await interaction.reply({
                content: `Added role ${role.name} to ${user.tag}.`,
                ephemeral: true,
            })
            return
        }

        if (action === "remove") {
            await memberToUpdate.roles.remove(role, reason).catch((err) => {
                console.error(err)
            })

            await auditLog(config, interaction.client, {
                actor: `${interaction.user.tag} (${interaction.user.id})`,
                action: "mod.role.remove",
                target: `${user.tag} (${user.id})`,
                detail: `role=${role.name}`,
            })

            await interaction.reply({
                content: `Removed role ${role.name} from ${user.tag}.`,
                ephemeral: true,
            })
            return
        }
    }

    if (sub === "timeout") {
        const user = interaction.options.getUser("user", true)
        const seconds = interaction.options.getInteger("seconds", true)
        const reason = formatReason(
            interaction,
            interaction.options.getString("reason"),
        )

        const memberToTimeout = await guild.members
            .fetch(user.id)
            .catch(() => null)
        if (!memberToTimeout) {
            await interaction.reply({
                content: "Could not find that member.",
                ephemeral: true,
            })
            return
        }

        const duration = Math.min(Math.max(seconds, 1), 2419200) // max 28 days
        await memberToTimeout.timeout(duration * 1000, reason).catch((err) => {
            console.error(err)
        })

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.tag} (${interaction.user.id})`,
            action: "mod.timeout",
            target: `${user.tag} (${user.id})`,
            detail: `seconds=${duration}`,
        })

        await interaction.reply({
            content: `Timed out ${user.tag} for ${duration} seconds.`,
            ephemeral: true,
        })
        return
    }
}
