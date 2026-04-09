import { ChannelType } from "discord.js"

export async function runSafeAction(actionName, interaction, config) {
    const actions = config.safeActions?.actions || {}
    const action = actions[actionName]
    if (!action) {
        throw new Error(`No safe action named '${actionName}' exists.`)
    }

    const guild = interaction.guild
    if (!guild) throw new Error("No guild context available")

    const results = []
    for (const step of action.steps ?? []) {
        switch (step.op) {
            case "create_category": {
                const category = await guild.channels.create({
                    name: step.name,
                    type: ChannelType.GuildCategory,
                })
                results.push({ step, success: true, id: category.id })
                break
            }
            case "create_channel": {
                const category = guild.channels.cache.find(
                    (c) =>
                        c.type === ChannelType.GuildCategory &&
                        c.name === step.category,
                )
                const channelType =
                    step.type === "voice"
                        ? ChannelType.GuildVoice
                        : step.type === "forum"
                          ? ChannelType.GuildForum
                          : ChannelType.GuildText
                const channel = await guild.channels.create({
                    name: step.name,
                    type: channelType,
                    parent: category?.id,
                })
                results.push({ step, success: true, id: channel.id })
                break
            }
            case "send_message": {
                const channel = guild.channels.cache.find(
                    (c) => c.name === step.channel,
                )
                if (!channel || !channel.isTextBased()) {
                    results.push({
                        step,
                        success: false,
                        error: "Channel not found or not text-based",
                    })
                    break
                }
                await channel.send(step.content)
                results.push({ step, success: true })
                break
            }
            case "add_role": {
                const target = interaction.options?.getUser?.("user")
                const role = guild.roles.cache.find(
                    (r) => r.name === step.role || r.id === step.role,
                )
                if (!target || !role) {
                    results.push({
                        step,
                        success: false,
                        error: "Target user or role not found",
                    })
                    break
                }
                const member = await guild.members.fetch(target.id)
                await member.roles.add(role)
                results.push({ step, success: true })
                break
            }
            case "remove_role": {
                const target = interaction.options?.getUser?.("user")
                const role = guild.roles.cache.find(
                    (r) => r.name === step.role || r.id === step.role,
                )
                if (!target || !role) {
                    results.push({
                        step,
                        success: false,
                        error: "Target user or role not found",
                    })
                    break
                }
                const member = await guild.members.fetch(target.id)
                await member.roles.remove(role)
                results.push({ step, success: true })
                break
            }
            case "delete_category": {
                const category = guild.channels.cache.find(
                    (c) =>
                        c.type === ChannelType.GuildCategory &&
                        c.name === step.name,
                )
                if (!category) {
                    results.push({
                        step,
                        success: false,
                        error: `Category '${step.name}' not found`,
                    })
                    break
                }
                // Delete all child channels first
                const children = guild.channels.cache.filter(
                    (c) => c.parentId === category.id,
                )
                for (const [, child] of children) {
                    await child.delete()
                }
                await category.delete()
                results.push({ step, success: true })
                break
            }
            case "delete_role": {
                const role = guild.roles.cache.find(
                    (r) => r.name === step.role || r.id === step.role,
                )
                if (!role) {
                    results.push({
                        step,
                        success: false,
                        error: `Role '${step.role}' not found`,
                    })
                    break
                }
                await role.delete()
                results.push({ step, success: true })
                break
            }
            case "archive_channel": {
                const channel = guild.channels.cache.find(
                    (c) => c.name === step.channel,
                )
                const archiveId = config.subjects?.archiveCategoryId
                if (!channel || !archiveId) {
                    results.push({
                        step,
                        success: false,
                        error: "Channel or archive category not found",
                    })
                    break
                }
                await channel.edit({ parent: archiveId })
                results.push({ step, success: true })
                break
            }
            default: {
                results.push({
                    step,
                    success: false,
                    error: "Unknown operation",
                })
                break
            }
        }
    }

    return results
}
