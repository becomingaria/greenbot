const { REST } = require("@discordjs/rest")
const { Routes } = require("discord-api-types/v10")
const fs = require("fs")
const path = require("path")
;(async () => {
    try {
        const token = process.env.DISCORD_TOKEN || process.env.TOKEN
        if (!token) throw new Error("DISCORD_TOKEN missing")
        const appId = "1484298026116710420"
        const guildId = "1146311296384507924"
        const folder = path.join(__dirname, "src", "commands")
        const commands = []
        for (const file of fs.readdirSync(folder)) {
            if (!file.endsWith(".js") || file === "index.js") continue
            const mod = require(path.join(folder, file))
            if (mod.data && typeof mod.data.toJSON === "function")
                commands.push(mod.data.toJSON())
        }
        const rest = new REST({ version: "10" }).setToken(token)
        const data = await rest.put(
            Routes.applicationGuildCommands(appId, guildId),
            { body: commands },
        )
        console.log("ok", data.length, "commands")
        const config = data.find((c) => c.name === "config")
        console.log(
            "configSubOptions:",
            config?.options?.map((o) => o.name),
        )
    } catch (e) {
        console.error("err", e)
        process.exit(1)
    }
})()
