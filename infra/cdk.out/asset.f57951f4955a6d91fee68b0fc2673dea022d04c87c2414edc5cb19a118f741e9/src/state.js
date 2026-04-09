import crypto from "crypto"
import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    DeleteItemCommand,
    ScanCommand,
} from "@aws-sdk/client-dynamodb"

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
        this.localRemember = new Map()
        this.localReminders = new Map()
        this.localMemberRoles = new Map()
    }

    // ---------------- Strike state ----------------
    async getStrike(guildId, userId) {
        if (!this.dynamoClient || !this.tableName) {
            const key = `${guildId}:${userId}`
            const entry = this.localStrikes.get(key) || {
                count: 0,
                expiresAt: 0,
            }
            if (unixSeconds() > entry.expiresAt)
                return { count: 0, expiresAt: 0 }
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

    // ---------------- Remember state ----------------
    async getRemember(guildId, key) {
        const id = buildKey("remember", [guildId, key])
        if (!this.dynamoClient || !this.tableName) {
            const entry = this.localRemember.get(id)
            if (!entry || unixSeconds() > entry.expiresAt) return null
            return entry
        }

        const res = await this.dynamoClient.send(
            new GetItemCommand({
                TableName: this.tableName,
                Key: { id: { S: id } },
            }),
        )
        if (!res.Item) return null
        const expiresAt = parseInt(res.Item[TTL_ATTRIBUTE]?.N ?? "0", 10)
        if (unixSeconds() > expiresAt) return null
        return {
            value: res.Item.value?.S ?? null,
            expiresAt,
            lastAccessed: parseInt(res.Item.lastAccessed?.N ?? "0", 10),
            warnedAt: parseInt(res.Item.warnedAt?.N ?? "0", 10) || 0,
        }
    }

    async setRemember(guildId, key, value, ttlSeconds = 60 * 60 * 24 * 30) {
        const now = unixSeconds()
        const expiresAt = now + ttlSeconds
        const id = buildKey("remember", [guildId, key])

        const item = {
            id: { S: id },
            value: { S: String(value) },
            lastAccessed: { N: now.toString() },
            [TTL_ATTRIBUTE]: { N: expiresAt.toString() },
        }

        if (!this.dynamoClient || !this.tableName) {
            this.localRemember.set(id, {
                value: String(value),
                lastAccessed: now,
                expiresAt,
                warnedAt: 0,
            })
            return { value: String(value), expiresAt }
        }

        await this.dynamoClient.send(
            new PutItemCommand({
                TableName: this.tableName,
                Item: item,
            }),
        )

        return { value: String(value), expiresAt }
    }

    async touchRemember(guildId, key, ttlSeconds = 60 * 60 * 24 * 30) {
        const existing = await this.getRemember(guildId, key)
        if (!existing) return null
        return this.setRemember(guildId, key, existing.value, ttlSeconds)
    }

    async deleteRemember(guildId, key) {
        const id = buildKey("remember", [guildId, key])
        if (!this.dynamoClient || !this.tableName) {
            return this.localRemember.delete(id)
        }

        await this.dynamoClient.send(
            new DeleteItemCommand({
                TableName: this.tableName,
                Key: { id: { S: id } },
            }),
        )
        return true
    }

    async listRemembers(guildId) {
        const prefix = buildKey("remember", [guildId])
        if (!this.dynamoClient || !this.tableName) {
            const now = unixSeconds()
            const results = []
            for (const [id, entry] of this.localRemember.entries()) {
                if (!id.startsWith(prefix)) continue
                if (now > entry.expiresAt) continue
                const key = id.split("#").slice(2).join("#")
                results.push({ key, ...entry })
            }
            return results
        }

        const res = await this.dynamoClient.send(
            new ScanCommand({
                TableName: this.tableName,
                FilterExpression: "begins_with(#id, :prefix)",
                ExpressionAttributeNames: { "#id": "id" },
                ExpressionAttributeValues: { ":prefix": { S: prefix } },
            }),
        )

        const now = unixSeconds()
        return (res.Items ?? [])
            .map((item) => {
                const id = item.id?.S || ""
                const key = id.split("#").slice(2).join("#")
                const expiresAt = parseInt(item[TTL_ATTRIBUTE]?.N ?? "0", 10)
                if (now > expiresAt) return null
                return {
                    key,
                    value: item.value?.S ?? null,
                    expiresAt,
                    lastAccessed: parseInt(item.lastAccessed?.N ?? "0", 10),
                    warnedAt: parseInt(item.warnedAt?.N ?? "0", 10) || 0,
                }
            })
            .filter(Boolean)
    }

    async setMemberRoles(guildId, memberKey, roles) {
        const key = buildKey("memberRole", [guildId, memberKey])
        const value = Array.isArray(roles)
            ? roles
            : String(roles).split(/\s*,\s*/)

        if (!this.dynamoClient || !this.tableName) {
            this.localMemberRoles.set(key, { roles: value })
            return { memberKey, roles: value }
        }

        await this.dynamoClient.send(
            new PutItemCommand({
                TableName: this.tableName,
                Item: {
                    id: { S: key },
                    roles: { S: JSON.stringify(value) },
                },
            }),
        )

        return { memberKey, roles: value }
    }

    async getMemberRoles(guildId, memberKey) {
        const key = buildKey("memberRole", [guildId, memberKey])

        if (!this.dynamoClient || !this.tableName) {
            const entry = this.localMemberRoles.get(key)
            return entry ? entry.roles : null
        }

        const res = await this.dynamoClient.send(
            new GetItemCommand({
                TableName: this.tableName,
                Key: { id: { S: key } },
            }),
        )
        if (!res.Item) return null
        try {
            return JSON.parse(res.Item.roles?.S ?? "[]")
        } catch {
            return []
        }
    }

    async deleteMemberRoles(guildId, memberKey) {
        const key = buildKey("memberRole", [guildId, memberKey])

        if (!this.dynamoClient || !this.tableName) {
            return this.localMemberRoles.delete(key)
        }

        await this.dynamoClient.send(
            new DeleteItemCommand({
                TableName: this.tableName,
                Key: { id: { S: key } },
            }),
        )
        return true
    }

    async listMemberRoles(guildId) {
        const prefix = buildKey("memberRole", [guildId])

        if (!this.dynamoClient || !this.tableName) {
            const results = []
            for (const [id, entry] of this.localMemberRoles.entries()) {
                if (!id.startsWith(prefix)) continue
                const key = id.split("#").slice(2).join("#")
                results.push({ memberKey: key, roles: entry.roles })
            }
            return results
        }

        const res = await this.dynamoClient.send(
            new ScanCommand({
                TableName: this.tableName,
                FilterExpression: "begins_with(#id, :prefix)",
                ExpressionAttributeNames: { "#id": "id" },
                ExpressionAttributeValues: { ":prefix": { S: prefix } },
            }),
        )

        return (res.Items ?? []).map((item) => {
            const id = item.id?.S || ""
            const key = id.split("#").slice(2).join("#")
            let roles = []
            try {
                roles = JSON.parse(item.roles?.S ?? "[]")
            } catch {
                roles = []
            }
            return { memberKey: key, roles }
        })
    }

    async getRememberWarnings(guildId, warnBeforeSeconds) {
        const now = unixSeconds()
        const warnBy = now + warnBeforeSeconds
        const prefix = buildKey("remember", [guildId])

        if (!this.dynamoClient || !this.tableName) {
            const results = []
            for (const [id, entry] of this.localRemember.entries()) {
                if (!id.startsWith(prefix)) continue
                if (entry.expiresAt > warnBy) continue
                if (entry.warnedAt && entry.warnedAt >= now) continue
                results.push({ id, ...entry })
            }
            return results
        }

        const res = await this.dynamoClient.send(
            new ScanCommand({
                TableName: this.tableName,
                FilterExpression:
                    "begins_with(#id, :prefix) AND #expiresAt <= :warnBy AND (attribute_not_exists(#warnedAt) OR #warnedAt < :now)",
                ExpressionAttributeNames: {
                    "#id": "id",
                    "#expiresAt": TTL_ATTRIBUTE,
                    "#warnedAt": "warnedAt",
                },
                ExpressionAttributeValues: {
                    ":prefix": { S: prefix },
                    ":warnBy": { N: warnBy.toString() },
                    ":now": { N: now.toString() },
                },
            }),
        )

        return (res.Items ?? []).map((item) => {
            const id = item.id?.S || ""
            return {
                id,
                key: id.split("#").slice(2).join("#"),
                value: item.value?.S ?? null,
                expiresAt: parseInt(item[TTL_ATTRIBUTE]?.N ?? "0", 10),
                warnedAt: parseInt(item.warnedAt?.N ?? "0", 10) || 0,
            }
        })
    }

    async markRememberWarned(guildId, key) {
        const id = buildKey("remember", [guildId, key])
        const now = unixSeconds()
        if (!this.dynamoClient || !this.tableName) {
            const entry = this.localRemember.get(id)
            if (!entry) return false
            entry.warnedAt = now
            this.localRemember.set(id, entry)
            return true
        }

        // Overwrite the existing item with a warnedAt timestamp.
        const existing = await this.getRemember(guildId, key)
        if (!existing) return false
        await this.dynamoClient.send(
            new PutItemCommand({
                TableName: this.tableName,
                Item: {
                    id: { S: id },
                    value: { S: existing.value ?? "" },
                    lastAccessed: {
                        N: (existing.lastAccessed ?? now).toString(),
                    },
                    warnedAt: { N: now.toString() },
                    [TTL_ATTRIBUTE]: {
                        N: (existing.expiresAt ?? now).toString(),
                    },
                },
            }),
        )
        return true
    }

    // ---------------- Reminder state ----------------
    async addReminder(
        guildId,
        channelId,
        userId,
        message,
        dueAt,
        keepDays = 7,
        options = {},
    ) {
        const now = unixSeconds()
        const reminderId = options.reminderId || crypto.randomUUID()
        const id = buildKey("reminder", [guildId, reminderId])
        const expiresAt = dueAt + keepDays * 24 * 60 * 60

        const item = {
            id: { S: id },
            guildId: { S: guildId },
            channelId: { S: channelId },
            userId: { S: userId },
            message: { S: String(message) },
            dueAt: { N: dueAt.toString() },
            sent: { BOOL: false },
            createdAt: { N: now.toString() },
            [TTL_ATTRIBUTE]: { N: expiresAt.toString() },
        }

        if (options.recurrence) {
            item.recurrence = { S: String(options.recurrence) }
        }

        if (!this.dynamoClient || !this.tableName) {
            this.localReminders.set(id, {
                ...item,
                reminderId,
                expiresAt,
                dueAt,
                sent: false,
                recurrence: options.recurrence || null,
            })
            return { reminderId, dueAt }
        }

        await this.dynamoClient.send(
            new PutItemCommand({
                TableName: this.tableName,
                Item: item,
            }),
        )

        return { reminderId, dueAt }
    }

    async getReminder(guildId, reminderId) {
        const id = buildKey("reminder", [guildId, reminderId])
        if (!this.dynamoClient || !this.tableName) {
            const item = this.localReminders.get(id)
            if (!item) return null
            return {
                reminderId,
                guildId: item.guildId,
                channelId: item.channelId,
                userId: item.userId,
                message: item.message,
                dueAt: item.dueAt,
                sent: item.sent,
                recurrence: item.recurrence,
            }
        }

        const res = await this.dynamoClient.send(
            new GetItemCommand({
                TableName: this.tableName,
                Key: { id: { S: id } },
            }),
        )
        if (!res.Item) return null
        return {
            reminderId,
            guildId: res.Item.guildId?.S,
            channelId: res.Item.channelId?.S,
            userId: res.Item.userId?.S,
            message: res.Item.message?.S,
            dueAt: parseInt(res.Item.dueAt?.N ?? "0", 10),
            sent: res.Item.sent?.BOOL ?? false,
            recurrence: res.Item.recurrence?.S ?? null,
        }
    }

    async updateReminder(guildId, reminderId, updates = {}) {
        const existing = await this.getReminder(guildId, reminderId)
        if (!existing) return null

        const id = buildKey("reminder", [guildId, reminderId])
        const now = unixSeconds()
        const dueAt = updates.dueAt ?? existing.dueAt
        const keepDays = updates.keepDays ?? 7
        const expiresAt = dueAt + keepDays * 24 * 60 * 60

        const item = {
            id: { S: id },
            guildId: { S: guildId },
            channelId: { S: updates.channelId ?? existing.channelId },
            userId: { S: updates.userId ?? existing.userId },
            message: { S: updates.message ?? existing.message },
            dueAt: { N: dueAt.toString() },
            sent: { BOOL: updates.sent ?? existing.sent ?? false },
            createdAt: { N: now.toString() },
            [TTL_ATTRIBUTE]: { N: expiresAt.toString() },
        }

        const recurrence = updates.recurrence ?? existing.recurrence
        if (recurrence) {
            item.recurrence = { S: String(recurrence) }
        }

        if (!this.dynamoClient || !this.tableName) {
            this.localReminders.set(id, {
                ...item,
                reminderId,
                expiresAt,
                dueAt,
                sent: updates.sent ?? existing.sent ?? false,
                recurrence,
            })
            return {
                reminderId,
                dueAt,
                sent: updates.sent ?? existing.sent ?? false,
                recurrence,
            }
        }

        await this.dynamoClient.send(
            new PutItemCommand({
                TableName: this.tableName,
                Item: item,
            }),
        )

        return {
            reminderId,
            dueAt,
            sent: updates.sent ?? existing.sent ?? false,
            recurrence,
        }
    }

    async getDueReminders(guildId, now = unixSeconds()) {
        const prefix = buildKey("reminder", [guildId])
        if (!this.dynamoClient || !this.tableName) {
            const results = []
            for (const [id, item] of this.localReminders.entries()) {
                if (!id.startsWith(prefix)) continue
                if (item.sent) continue
                if (item.dueAt > now) continue
                results.push({ ...item, id })
            }
            return results
        }

        const res = await this.dynamoClient.send(
            new ScanCommand({
                TableName: this.tableName,
                FilterExpression:
                    "begins_with(#id, :prefix) AND #dueAt <= :now AND (attribute_not_exists(#sent) OR #sent = :false)",
                ExpressionAttributeNames: {
                    "#id": "id",
                    "#dueAt": "dueAt",
                    "#sent": "sent",
                },
                ExpressionAttributeValues: {
                    ":prefix": { S: prefix },
                    ":now": { N: now.toString() },
                    ":false": { BOOL: false },
                },
            }),
        )

        return (res.Items ?? []).map((item) => {
            const id = item.id?.S || ""
            const parts = id.split("#")
            const reminderId = parts[2] ?? ""
            return {
                id,
                reminderId,
                guildId: item.guildId?.S,
                channelId: item.channelId?.S,
                userId: item.userId?.S,
                message: item.message?.S,
                dueAt: parseInt(item.dueAt?.N ?? "0", 10),
                sent: item.sent?.BOOL ?? false,
                recurrence: item.recurrence?.S ?? null,
            }
        })
    }

    async deleteReminder(guildId, reminderId) {
        const id = buildKey("reminder", [guildId, reminderId])
        if (!this.dynamoClient || !this.tableName) {
            return this.localReminders.delete(id)
        }

        await this.dynamoClient.send(
            new DeleteItemCommand({
                TableName: this.tableName,
                Key: { id: { S: id } },
            }),
        )
        return true
    }

    async listReminders(guildId, userId) {
        const prefix = buildKey("reminder", [guildId])
        if (!this.dynamoClient || !this.tableName) {
            const results = []
            for (const [id, item] of this.localReminders.entries()) {
                if (!id.startsWith(prefix)) continue
                if (userId && item.userId !== userId) continue
                const parts = id.split("#")
                results.push({
                    reminderId: parts[2] ?? "",
                    guildId: item.guildId,
                    channelId: item.channelId,
                    userId: item.userId,
                    message: item.message,
                    dueAt: item.dueAt,
                    sent: item.sent,
                    recurrence: item.recurrence,
                    lastAccessed: item.lastAccessed,
                })
            }
            return results
        }

        const filterParts = ["begins_with(#id, :prefix)"]
        const expressionValues = {
            ":prefix": { S: prefix },
        }
        if (userId) {
            filterParts.push("#userId = :userId")
            expressionValues[":userId"] = { S: userId }
        }

        const res = await this.dynamoClient.send(
            new ScanCommand({
                TableName: this.tableName,
                FilterExpression: filterParts.join(" AND "),
                ExpressionAttributeNames: {
                    "#id": "id",
                    "#userId": "userId",
                },
                ExpressionAttributeValues: expressionValues,
            }),
        )

        return (res.Items ?? []).map((item) => {
            const id = item.id?.S || ""
            const parts = id.split("#")
            return {
                reminderId: parts[2] ?? "",
                guildId: item.guildId?.S,
                channelId: item.channelId?.S,
                userId: item.userId?.S,
                message: item.message?.S,
                dueAt: parseInt(item.dueAt?.N ?? "0", 10),
                sent: item.sent?.BOOL ?? false,
                recurrence: item.recurrence?.S ?? null,
                lastAccessed: parseInt(item.lastAccessed?.N ?? "0", 10) || 0,
            }
        })
    }
}
