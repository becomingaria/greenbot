import { SlashCommandBuilder } from "@discordjs/builders"
import { PermissionsBitField } from "discord.js"
import yaml from "yaml"

export const data = new SlashCommandBuilder()
    .setName("config")
    .setDescription("Admin config management")
    .addSubcommand((sub) =>
        sub
            .setName("show")
            .setDescription("Show the current config (sanitized)."),
    )
    .addSubcommand((sub) =>
        sub
            .setName("export")
            .setDescription("Export current config as a YAML file."),
    )
    .addSubcommand((sub) =>
        sub
            .setName("validate")
            .setDescription(
                "Validate the most recent YAML config attachment in this channel.",
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("apply")
            .setDescription(
                "Apply a validated config, storing it in the configured store.",
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("rollback")
            .setDescription("Rollback to a previous config version.")
            .addStringOption((opt) =>
                opt
                    .setName("version")
                    .setDescription(
                        "Version key (timestamp) to rollback to. Omit for latest.",
                    )
                    .setRequired(false),
            ),
    )

function isAuthorized(interaction, config) {
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

async function findLatestAttachmentFromUser(interaction) {
    const channel = interaction.channel
    if (!channel || !channel.isTextBased()) return null

    const messages = await channel.messages.fetch({ limit: 20 })
    const candidates = messages
        .filter(
            (m) =>
                m.author.id === interaction.user.id && m.attachments.size > 0,
        )
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)

    const message = candidates.first()
    if (!message) return null

    const attachment = message.attachments.first()
    if (!attachment) return null

    const res = await fetch(attachment.url)
    const text = await res.text()
    const parsed = attachment.name?.endsWith(".json")
        ? JSON.parse(text)
        : yaml.parse(text)
    return parsed
}

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const sub = interaction.options.getSubcommand()
    const { configManager, sanitizeConfig } = context
    const config = configManager?.getCurrentConfig?.() ?? context.config

    if (!config) {
        await interaction.reply({
            content: "Config is not loaded yet.",
            ephemeral: true,
        })
        return
    }

    const adminChannelId = config.admin?.controlChannelId
    if (sub !== "show") {
        if (adminChannelId && interaction.channelId !== adminChannelId) {
            await interaction.reply({
                content:
                    "This command can only be used in the configured admin channel.",
                ephemeral: true,
            })
            return
        }

        if (!isAuthorized(interaction, config)) {
            await interaction.reply({
                content: "You are not authorized to run this command.",
                ephemeral: true,
            })
            return
        }
    }

    if (sub === "show") {
        const sanitized = sanitizeConfig(config)
        const payload = JSON.stringify(sanitized, null, 2)
        const fileName = `config-${config.guild?.id ?? "unknown"}.json`

        await interaction.reply({
            content: "Here is the current config (sensitive values redacted).",
            files: [
                { attachment: Buffer.from(payload, "utf8"), name: fileName },
            ],
            ephemeral: true,
        })
        return
    }

    if (sub === "export") {
        const yamlPayload = yaml.stringify(config)
        const fileName = `config-${config.guild?.id ?? "unknown"}.yaml`
        await interaction.reply({
            content: "Here is the current config as YAML.",
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

    if (sub === "validate") {
        const candidate = await findLatestAttachmentFromUser(interaction)
        if (!candidate) {
            await interaction.reply({
                content:
                    "No config attachment found in the last few messages. Upload a YAML/JSON file and try again.",
                ephemeral: true,
            })
            return
        }

        try {
            await configManager.bufferCandidateConfig(
                config.guild.id,
                interaction.user.id,
                candidate,
            )
            await interaction.reply({
                content:
                    "Config validated successfully. Run `/config apply` to apply it.",
                ephemeral: true,
            })
        } catch (err) {
            await interaction.reply({
                content: `Config validation failed: ${err.message}`,
                ephemeral: true,
            })
        }

        return
    }

    if (sub === "apply") {
        try {
            const { config: applied } =
                await configManager.applyCandidateConfig(
                    config.guild.id,
                    interaction.user.id,
                )
            // Update runtime config reference so other commands see it
            if (interaction.client) {
                interaction.client.config = applied
            }

            await interaction.reply({
                content: "Config applied successfully.",
                ephemeral: true,
            })
        } catch (err) {
            await interaction.reply({
                content: `Failed to apply config: ${err.message}`,
                ephemeral: true,
            })
        }

        return
    }

    if (sub === "rollback") {
        if (!configManager?.s3Bucket) {
            await interaction.reply({
                content:
                    "Rollback is only supported when config is stored in S3.",
                ephemeral: true,
            })
            return
        }

        const version = interaction.options.getString("version")
        try {
            const versions = await configManager.listVersions(config.guild.id)
            if (!versions.length) {
                await interaction.reply({
                    content: "No config versions found to rollback to.",
                    ephemeral: true,
                })
                return
            }

            const target = version
                ? versions.find((v) => v.key.endsWith(`${version}.yaml`))
                : versions[0]

            if (!target) {
                await interaction.reply({
                    content:
                        "Could not find that version. Provide a valid version key.",
                    ephemeral: true,
                })
                return
            }

            const loaded = await configManager.loadVersion(
                config.guild.id,
                target.key,
            )
            await configManager.saveConfig(loaded)
            if (interaction.client) {
                interaction.client.config = loaded
            }

            await interaction.reply({
                content: `Rolled back to version ${target.key} successfully.`,
                ephemeral: true,
            })
        } catch (err) {
            await interaction.reply({
                content: `Rollback failed: ${err.message}`,
                ephemeral: true,
            })
        }

        return
    }
}
