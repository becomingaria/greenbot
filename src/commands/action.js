import { SlashCommandBuilder } from "@discordjs/builders"
import { runSafeAction } from "../actions.js"
import { auditLog } from "../audit.js"
import { requireAdmin, ensureAdminChannel } from "../utils.js"

export const data = new SlashCommandBuilder()
    .setName("action")
    .setDescription("Run safe predefined actions")
    .addSubcommand((sub) =>
        sub.setName("list").setDescription("List available safe actions."),
    )
    .addSubcommand((sub) =>
        sub
            .setName("run")
            .setDescription("Run a safe action defined in config.")
            .addStringOption((opt) =>
                opt
                    .setName("name")
                    .setDescription("Name of the safe action to run")
                    .setRequired(true),
            ),
    )
    .addSubcommand((sub) =>
        sub
            .setName("add")
            .setDescription("Add a new safe action to the config.")
            .addStringOption((opt) =>
                opt
                    .setName("name")
                    .setDescription("Name of the safe action to create")
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("description")
                    .setDescription("Human-friendly description of the action"),
            )
            .addStringOption((opt) =>
                opt
                    .setName("steps")
                    .setDescription(
                        'JSON or YAML array of steps (e.g. [{"op":"create_category",...}])',
                    )
                    .setRequired(true),
            ),
    )

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return
    const config = context.configManager?.getCurrentConfig?.() ?? context.config

    if (!config || !config.features?.safeActions) {
        await interaction.reply({
            content: "Safe actions are not enabled in config.",
            ephemeral: true,
        })
        return
    }

    if (!ensureAdminChannel(interaction, config)) return
    if (!requireAdmin(interaction, config)) return

    const sub = interaction.options.getSubcommand()
    const actions = config.safeActions?.actions || {}

    if (sub === "list") {
        const names = Object.keys(actions)
        if (!names.length) {
            await interaction.reply({
                content: "No safe actions are configured.",
                ephemeral: true,
            })
            return
        }

        const lines = names.map(
            (n) =>
                `• **${n}**: ${actions[n].description ?? "(no description)"}`,
        )
        await interaction.reply({
            content: `Available actions:\n${lines.join("\n")}`,
            ephemeral: true,
        })
        return
    }

    if (sub === "run") {
        const name = interaction.options.getString("name", true)
        try {
            const results = await runSafeAction(name, interaction, config)
            const ok = results.every((r) => r.success)
            const message = results
                .map(
                    (r) =>
                        `- ${r.step.op}: ${r.success ? "OK" : "FAIL"}${r.error ? ` (${r.error})` : ""}`,
                )
                .join("\n")

            await auditLog(config, interaction.client, {
                actor: `${interaction.user.tag} (${interaction.user.id})`,
                action: "action.run",
                target: name,
                detail: `success=${ok}`,
            })

            await interaction.reply({
                content: `Action **${name}** completed (success=${ok}):\n${message}`,
                ephemeral: true,
            })
        } catch (err) {
            await interaction.reply({
                content: `Action failed: ${err.message}`,
                ephemeral: true,
            })
        }
        return
    }

    if (sub === "add") {
        const name = interaction.options.getString("name", true)
        const description = interaction.options.getString("description") ?? ""
        const stepsText = interaction.options.getString("steps", true)
        let steps

        try {
            // Allow JSON or YAML for flexibility
            steps = JSON.parse(stepsText)
        } catch {
            try {
                const yaml = await import("yaml")
                steps = yaml.parse(stepsText)
            } catch (err) {
                await interaction.reply({
                    content:
                        "Failed to parse steps. Provide valid JSON or YAML representing an array of steps.",
                    ephemeral: true,
                })
                return
            }
        }

        if (!Array.isArray(steps)) {
            await interaction.reply({
                content: "Steps must be an array of operations.",
                ephemeral: true,
            })
            return
        }

        // Basic validation of ops
        const allowedOps = new Set([
            "create_category",
            "create_channel",
            "send_message",
            "add_role",
            "remove_role",
            "archive_channel",
        ])
        const invalid = steps.find((s) => !s.op || !allowedOps.has(s.op))
        if (invalid) {
            await interaction.reply({
                content: `Invalid step: ${JSON.stringify(invalid)}. Allowed ops: ${[
                    ...allowedOps,
                ].join(", ")}`,
                ephemeral: true,
            })
            return
        }

        const newConfig = { ...config }
        newConfig.safeActions = newConfig.safeActions || {}
        newConfig.safeActions.actions = newConfig.safeActions.actions || {}
        newConfig.safeActions.actions[name] = {
            description,
            steps,
        }

        try {
            await context.configManager.saveConfig(newConfig)
            if (interaction.client) {
                interaction.client.config = newConfig
            }

            await auditLog(config, interaction.client, {
                actor: `${interaction.user.tag} (${interaction.user.id})`,
                action: "action.add",
                target: name,
                detail: description,
            })

            await interaction.reply({
                content: `Added safe action **${name}**. Run it with /action run ${name}`,
                ephemeral: true,
            })
        } catch (err) {
            await interaction.reply({
                content: `Failed to save action: ${err.message}`,
                ephemeral: true,
            })
        }

        return
    }
}
