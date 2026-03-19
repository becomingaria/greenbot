import { Client, GatewayIntentBits, Partials, Collection } from "discord.js"
import { REST } from "@discordjs/rest"
import { Routes } from "discord-api-types/v10"
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm"
import { loadCommands } from "./commands/index.js"
import { loadConfig, sanitizeConfig } from "./config.js"

const GUILD_ID = process.env.GUILD_ID
const APP_ID = process.env.APP_ID

async function resolveToken() {
    if (process.env.DISCORD_TOKEN) {
        return process.env.DISCORD_TOKEN
    }

    const paramName = process.env.DISCORD_TOKEN_SSM_PARAM
    if (!paramName) {
        throw new Error(
            "Missing Discord token configuration. Set DISCORD_TOKEN or DISCORD_TOKEN_SSM_PARAM.",
        )
    }

    const client = new SSMClient({})
    const command = new GetParameterCommand({
        Name: paramName,
        WithDecryption: true,
    })
    const result = await client.send(command)
    const value = result.Parameter?.Value
    if (!value) {
        throw new Error(
            `SSM parameter ${paramName} is missing or empty; cannot start bot.`,
        )
    }

    return value
}

async function main() {
    if (!APP_ID) {
        console.error("Missing APP_ID environment variable.")
        process.exit(1)
    }

    const TOKEN = await resolveToken()

    const config = await loadConfig()

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel],
    })

    client.commands = new Collection()
    client.config = config
    client.sanitizeConfig = sanitizeConfig

    const commands = await loadCommands()
    for (const [name, cmd] of commands) {
        client.commands.set(name, cmd)
    }

    client.once("ready", async () => {
        console.log(`Logged in as ${client.user.tag}`)

        // Register commands in the guild (fast update during development).
        if (!GUILD_ID) {
            console.warn(
                "GUILD_ID not set; skipping guild command registration.",
            )
            return
        }

        const rest = new REST({ version: "10" }).setToken(TOKEN)
        const commandData = Array.from(client.commands.values()).map((cmd) =>
            cmd.data.toJSON(),
        )
        try {
            console.log(
                `Registering ${commandData.length} commands to guild ${GUILD_ID}...`,
            )
            await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), {
                body: commandData,
            })
            console.log("Commands registered.")
        } catch (error) {
            console.error("Failed to register commands", error)
        }
    })

    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isChatInputCommand()) return
        const command = client.commands.get(interaction.commandName)
        if (!command) return

        try {
            await command.execute(interaction, { config, sanitizeConfig })
        } catch (error) {
            console.error(error)
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: "There was an error executing that command.",
                    ephemeral: true,
                })
            } else {
                await interaction.reply({
                    content: "There was an error executing that command.",
                    ephemeral: true,
                })
            }
        }
    })

    await client.login(TOKEN)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
