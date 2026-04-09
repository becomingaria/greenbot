export async function auditLog(
    config,
    client,
    { actor, action, target, detail },
) {
    const channelId = config.logging?.auditChannelId
    if (!channelId) return

    const guild = client.guilds.cache.get(config.guild.id)
    if (!guild) return
    const channel = guild.channels.cache.get(channelId)
    if (!channel || !channel.isTextBased()) return

    const parts = []
    if (actor) parts.push(`**Actor**: ${actor}`)
    if (action) parts.push(`**Action**: ${action}`)
    if (target) parts.push(`**Target**: ${target}`)
    if (detail) parts.push(`**Detail**: ${detail}`)

    await channel.send({ content: parts.join("\n") })
}
