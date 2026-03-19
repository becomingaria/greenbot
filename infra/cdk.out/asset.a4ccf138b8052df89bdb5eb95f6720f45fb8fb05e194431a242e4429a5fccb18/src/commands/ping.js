import { SlashCommandBuilder } from "@discordjs/builders"

export const data = new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Basic bot health check.")

export async function execute(interaction) {
    if (!interaction.isChatInputCommand()) return
    const sent = await interaction.reply({
        content: "Pong!",
        fetchReply: true,
        ephemeral: true,
    })
    const latency = sent.createdTimestamp - interaction.createdTimestamp
    await interaction.editReply(`Pong! ${latency}ms`)
}
