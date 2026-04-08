import { Client, GatewayIntentBits, Partials, Collection } from "discord.js"
import { REST } from "@discordjs/rest"
import { Routes } from "discord-api-types/v10"
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm"
import { loadCommands } from "./commands/index.js"
import { ConfigManager } from "./configManager.js"
import { sanitizeConfig } from "./config.js"
import { runAutomod } from "./automod.js"
import { runQa } from "./qa.js"
import { StateStore } from "./state.js"
import { startMaintenance } from "./reminders.js"

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

    const configManager = new ConfigManager({
        s3Bucket: process.env.CONFIG_S3_BUCKET,
        localPath: process.env.CONFIG_PATH,
    })
    await configManager.init()

    const stateStore = new StateStore({
        tableName:
            process.env.DYNAMODB_TABLE_NAME || process.env.STATE_DDB_TABLE,
    })

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
        ],
        partials: [Partials.Channel],
    })

    client.commands = new Collection()
    client.configManager = configManager
    client.sanitizeConfig = sanitizeConfig
    client.stateStore = stateStore

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

        // Start background maintenance tasks (reminders, remember warnings, etc.)
        startMaintenance(client, configManager)
    })

    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isChatInputCommand()) return
        if (interaction.channel?.name !== "bot-admin") return
        const command = client.commands.get(interaction.commandName)
        if (!command) return

        const config = await client.configManager.getConfig(
            interaction.guildId || "",
        )

        try {
            await command.execute(interaction, {
                config,
                sanitizeConfig,
                configManager,
            })
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

    client.on("messageCreate", async (message) => {
        if (!message.guild) return
        const config = await client.configManager.getConfig(message.guild.id)
        try {
            await runAutomod(message, config)
            await runQa(message, config)
        } catch (err) {
            console.error("Error in message pipeline", err)
        }
    })

    client.on("guildMemberAdd", async (member) => {
        try {
            const guild = member.guild
            if (!guild) return

            const config = await client.configManager.getConfig(guild.id)
            if (!config) return

            // allow this for members when feature enabled
            if (!config.features?.subjects) return

            const stateStore = client.stateStore
            const userId = member.user.id
            const userTag = member.user.tag.toLowerCase()

            const rolesFromId = await stateStore.getMemberRoles(
                guild.id,
                userId,
            )
            const rolesFromTag = await stateStore.getMemberRoles(
                guild.id,
                userTag,
            )
            const roles = (rolesFromId || []).concat(rolesFromTag || [])

            const dedup = [...new Set(roles)]
            if (!dedup.length) return

            const roleObjs = dedup
                .map((name) => guild.roles.cache.find((r) => r.name === name))
                .filter((r) => r)

            if (!roleObjs.length) return

            await member.roles.add(roleObjs).catch((err) => {
                console.error("Failed to assign roles on join", err)
            })
        } catch (err) {
            console.error("Error in guildMemberAdd", err)
        }
    })

    await client.login(TOKEN)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
