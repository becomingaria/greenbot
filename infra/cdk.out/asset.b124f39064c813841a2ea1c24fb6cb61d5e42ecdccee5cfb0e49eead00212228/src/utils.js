import { PermissionsBitField } from "discord.js"

export function isAdminUser(interaction, config) {
    const {
        allowedUserIds = [],
        allowedRoleIds = [],
        requireDiscordPermissions,
    } = config.admin || {}

    if (allowedUserIds.includes(interaction.user.id)) return true

    const member = interaction.member
    if (member && member.roles) {
        const hasRole = allowedRoleIds.some((roleId) =>
            member.roles.cache.has(roleId),
        )
        if (hasRole) return true
    }

    if (requireDiscordPermissions) {
        const perms = PermissionsBitField.Flags.ManageGuild
        if (!member || !member.permissions.has(perms)) {
            return false
        }
    }

    return false
}

export function requireAdmin(interaction, config) {
    if (!isAdminUser(interaction, config)) {
        interaction.reply({
            content: "You are not authorized to run this command.",
            ephemeral: true,
        })
        return false
    }
    return true
}

export function ensureAdminChannel(interaction, config) {
    const adminChannelId = config.admin?.controlChannelId
    if (adminChannelId && interaction.channelId !== adminChannelId) {
        interaction.reply({
            content:
                "This command can only be used in the configured admin channel.",
            ephemeral: true,
        })
        return false
    }
    return true
}

export function normalizeId(value) {
    if (!value) return null
    return String(value).replace(/[^0-9]/g, "")
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
