import { SlashCommandBuilder } from "@discordjs/builders"
import { MessageFlags } from "discord.js"

export const data = new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Basic bot health check.")

export async function execute(interaction) {
    if (!interaction.isChatInputCommand()) return
    const { resource } = await interaction.reply({
        content: "Pong!",
        withResponse: true,
        flags: MessageFlags.Ephemeral,
    })
    const latency =
        resource.message.createdTimestamp - interaction.createdTimestamp
    await interaction.editReply(`Pong! ${latency}ms`)
}
