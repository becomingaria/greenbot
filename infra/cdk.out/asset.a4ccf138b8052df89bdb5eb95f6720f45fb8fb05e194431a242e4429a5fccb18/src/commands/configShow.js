import { SlashCommandBuilder } from "@discordjs/builders"

export const data = new SlashCommandBuilder()
    .setName("config")
    .setDescription("Admin config helpers")
    .addSubcommand((sub) =>
        sub
            .setName("show")
            .setDescription("Show the current config (sanitized)."),
    )

export async function execute(interaction, context) {
    if (!interaction.isChatInputCommand()) return

    const sub = interaction.options.getSubcommand()
    if (sub === "show") {
        const config = context.config
        const sanitized = context.sanitizeConfig(config)

        // Discord has message size limits; sending as file when large.
        const payload = JSON.stringify(sanitized, null, 2)
        const fileName = `config-${config.guild?.id ?? "unknown"}.json`

        await interaction.reply({
            content: "Here is the current config (sensitive values redacted).",
            files: [
                { attachment: Buffer.from(payload, "utf8"), name: fileName },
            ],
            ephemeral: true,
        })
    }
}
