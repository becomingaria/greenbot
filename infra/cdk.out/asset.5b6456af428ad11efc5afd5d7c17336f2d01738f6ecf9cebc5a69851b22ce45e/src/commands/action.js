import { SlashCommandBuilder } from "@discordjs/builders"
import { runSafeAction } from "../actions.js"
import { auditLog } from "../audit.js"

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
}
