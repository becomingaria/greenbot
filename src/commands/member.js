import { SlashCommandBuilder } from "@discordjs/builders"
import { MessageFlags } from "discord.js"
import { auditLog } from "../audit.js"

import { StateStore } from "../state.js"

const stateStore = new StateStore({
    tableName: process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
})

function normalizeUserKey(value) {
    if (!value) return null
    const trimmed = String(value).trim()
    const mentionMatch = trimmed.match(/^<@!?(\d+)>$/)
    if (mentionMatch) return mentionMatch[1]
    if (/^\d{17,19}$/.test(trimmed)) return trimmed
    if (trimmed.includes("#")) return trimmed.toLowerCase()
    return trimmed.toLowerCase()
}

function parseRoles(value) {
    return String(value)
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
}

async function applyRolesToMember(member, roles) {
    if (!roles?.length) return

    const targets = roles
        .map((name) => member.guild.roles.cache.find((r) => r.name === name))
        .filter((r) => r)

    if (targets.length) {
        await member.roles.add(targets).catch(() => null)
    }
}

async function applyRolesByMapping(guild, mapping) {
    for (const [userKey, roles] of Object.entries(mapping)) {
        let member = null
        if (/^\d{17,19}$/.test(userKey)) {
            member = await guild.members.fetch(userKey).catch(() => null)
        }
        if (!member) {
            member = guild.members.cache.find(
                (m) => m.user.username.toLowerCase() === userKey.toLowerCase(),
            )
        }
        if (member) {
            await applyRolesToMember(member, roles)
        }
    }
}

export const data = new SlashCommandBuilder()
    .setName("member")
    .setDescription("Manage member role template assignments")
    .addSubcommand((sub) =>
        sub
            .setName("set")
            .setDescription("Set role assignment for a username/userid")
            .addStringOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("Discord user mention/id/tag")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("roles")
                    .setDescription("Comma-separated role names")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("remove")
            .setDescription("Remove stored role assignment for a user")
            .addStringOption((opt) =>
                opt
                    .setName("user")
                    .setDescription("Discord user mention/id/tag")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("list")
            .setDescription("List stored member role assignments"),
    )
    .addSubcommand((sub) =>
        sub
            .setName("batch")
            .setDescription(
                "Set multiple mappings with newline list user:role1,role2",
            )
            .addStringOption((opt) =>
                opt
                    .setName("data")
                    .setDescription("Lines: user#1234: a,b,c")
                    .setRequired(true),
            ),
    )

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const config = context.config ?? context.configManager?.getCurrentConfig?.()
    if (!config) {
        await interaction.reply({
            content: "Config is not loaded yet.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const guild = interaction.guild
    if (!guild) {
        await interaction.reply({
            content: "This command must be used in a server.",
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const sub = interaction.options.getSubcommand()

    if (sub === "set") {
        const userValue = interaction.options.getString("user", true)
        const rolesValue = interaction.options.getString("roles", true)
        const memberKey = normalizeUserKey(userValue)
        const roles = parseRoles(rolesValue)

        if (!memberKey || !roles.length) {
            await interaction.reply({
                content: "Invalid user or role list provided.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        await stateStore.setMemberRoles(guild.id, memberKey, roles)
        await applyRolesByMapping(guild, { [memberKey]: roles })

        await auditLog(config, interaction.client, {
            actor: `${interaction.user.username} (${interaction.user.id})`,
            action: "member.set",
            target: memberKey,
            detail: `roles=${roles.join(",")}`,
        })

        await interaction.reply({
            content: `Set roles for ${memberKey}: ${roles.join(", ")}.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "remove") {
        const userValue = interaction.options.getString("user", true)
        const memberKey = normalizeUserKey(userValue)

        if (!memberKey) {
            await interaction.reply({
                content: "Invalid user provided.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        await stateStore.deleteMemberRoles(guild.id, memberKey)
        await interaction.reply({
            content: `Removed role assignment for ${memberKey}.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "list") {
        const entries = await stateStore.listMemberRoles(guild.id)
        if (!entries.length) {
            await interaction.reply({
                content: "No member role assignments stored.",
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        const lines = entries.map(
            (entry) => `${entry.memberKey}: ${entry.roles.join(", ")}`,
        )
        await interaction.reply({
            content: `Member assignments:\n${lines.join("\n")}`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    if (sub === "batch") {
        const data = interaction.options.getString("data", true)
        const lines = data
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        const parsed = {}

        for (const line of lines) {
            const parts = line.split(":")
            if (parts.length < 2) continue
            const user = normalizeUserKey(parts[0])
            const roles = parseRoles(parts.slice(1).join(":"))
            if (!user || !roles.length) continue
            parsed[user] = roles
            await stateStore.setMemberRoles(guild.id, user, roles)
        }

        await applyRolesByMapping(guild, parsed)

        await interaction.reply({
            content: `Processed ${Object.keys(parsed).length} member assignments.`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }
}
