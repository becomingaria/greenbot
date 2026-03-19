import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb"

const TTL_ATTRIBUTE = "expiresAt"

function unixSeconds() {
  return Math.floor(Date.now() / 1000)
}

function buildKey(prefix, components) {
  return `${prefix}#${components.join("#")}`
}

function toDynamoItem(value) {
  if (typeof value === "string") return { S: value }
  if (typeof value === "number") return { N: value.toString() }
  if (typeof value === "boolean") return { BOOL: value }
  return { S: JSON.stringify(value) }
}

export class StateStore {
  constructor({ tableName, dynamoClient } = {}) {
    this.tableName = tableName
    this.dynamoClient =
      dynamoClient || (tableName ? new DynamoDBClient({}) : null)

    // fallback in-memory
    this.localStrikes = new Map()
    this.localCooldowns = new Map()
  }

  // ---------------- Strike state ----------------
  async getStrike(guildId, userId) {
    if (!this.dynamoClient || !this.tableName) {
      const key = `${guildId}:${userId}`
      const entry = this.localStrikes.get(key) || { count: 0, expiresAt: 0 }
      if (unixSeconds() > entry.expiresAt) return { count: 0, expiresAt: 0 }
      return entry
    }

    const key = buildKey("strike", [guildId, userId])
    const res = await this.dynamoClient.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { id: { S: key } },
      }),
    )
    if (!res.Item) return { count: 0, expiresAt: 0 }
    const count = parseInt(res.Item.count?.N ?? "0", 10)
    const expiresAt = parseInt(res.Item[TTL_ATTRIBUTE]?.N ?? "0", 10)
    if (unixSeconds() > expiresAt) return { count: 0, expiresAt: 0 }
    return { count, expiresAt }
  }

  async addStrike(guildId, userId, ttlSeconds, increment = 1) {
    const now = unixSeconds()
    const expiresAt = now + ttlSeconds

    if (!this.dynamoClient || !this.tableName) {
      const key = `${guildId}:${userId}`
      const existing = await this.getStrike(guildId, userId)
      const next = { count: existing.count + increment, expiresAt }
      this.localStrikes.set(key, next)
      return next
    }

    const key = buildKey("strike", [guildId, userId])
    const existing = await this.getStrike(guildId, userId)
    const nextCount = existing.count + increment

    await this.dynamoClient.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          id: { S: key },
          count: { N: nextCount.toString() },
          [TTL_ATTRIBUTE]: { N: expiresAt.toString() },
        },
      }),
    )

    return { count: nextCount, expiresAt }
  }

  // ---------------- Cooldown state ----------------
  async getCooldown(ruleId, channelId, userId) {
    if (!this.dynamoClient || !this.tableName) {
      const key = `${ruleId}:${channelId}:${userId}`
      const entry = this.localCooldowns.get(key) || { expiresAt: 0 }
      if (unixSeconds() > entry.expiresAt) return { expiresAt: 0 }
      return entry
    }

    const key = buildKey("cd", [ruleId, channelId, userId])
    const res = await this.dynamoClient.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { id: { S: key } },
      }),
    )
    if (!res.Item) return { expiresAt: 0 }
    const expiresAt = parseInt(res.Item[TTL_ATTRIBUTE]?.N ?? "0", 10)
    if (unixSeconds() > expiresAt) return { expiresAt: 0 }
    return { expiresAt }
  }

  async setCooldown(ruleId, channelId, userId, ttlSeconds) {
    const expiresAt = unixSeconds() + ttlSeconds

    if (!this.dynamoClient || !this.tableName) {
      const key = `${ruleId}:${channelId}:${userId}`
      const entry = { expiresAt }
      this.localCooldowns.set(key, entry)
      return entry
    }

    const key = buildKey("cd", [ruleId, channelId, userId])
    await this.dynamoClient.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          id: { S: key },
          [TTL_ATTRIBUTE]: { N: expiresAt.toString() },
        },
      }),
    )

    return { expiresAt }
  }
}
