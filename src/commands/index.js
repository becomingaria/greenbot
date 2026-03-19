import fs from "fs"
import path from "path"

export async function loadCommands() {
    const commands = new Map()
    const commandsPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "commands",
    )
    const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"))
    for (const file of files) {
        const module = await import(path.join(commandsPath, file))
        if (module.data && module.execute) {
            commands.set(module.data.name, module)
        }
    }
    return commands
}
