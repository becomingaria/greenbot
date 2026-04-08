import fs from "fs/promises"
import path from "path"
import yaml from "yaml"
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3"
import { validateConfig, sanitizeConfig } from "./config.js"

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config/config.yaml")

function isoTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-")
}

async function streamToString(stream) {
    const chunks = []
    for await (const chunk of stream) {
        chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
}

export class ConfigManager {
    /**
     * @param {{ s3Bucket?: string, s3Prefix?: string, localPath?: string }} opts
     */
    constructor({ s3Bucket, s3Prefix = "configs", localPath } = {}) {
        this.s3Bucket = s3Bucket
        this.s3Prefix = s3Prefix
        this.localPath = localPath || DEFAULT_CONFIG_PATH

        this.s3Client = s3Bucket ? new S3Client({}) : null
        this.defaultConfig = null
        this.configs = new Map() // guildId -> config
        this.candidates = new Map() // key: `${guildId}:${userId}` -> { config, timestamp }
    }

    async init() {
        const local = await this._loadLocalConfig()
        this.defaultConfig = validateConfig(local)
        this.configs.set(
            this.defaultConfig.guild?.id ?? "default",
            this.defaultConfig,
        )
        return this.defaultConfig
    }

    async _loadLocalConfig() {
        const stat = await fs.stat(this.localPath).catch(() => null)
        if (stat && stat.isDirectory()) {
            // Not a single config file; leave it to getConfig to load per-guild files.
            return this.defaultConfig ?? {}
        }

        const raw = await fs.readFile(this.localPath, "utf8")
        return yaml.parse(raw)
    }

    async _loadLocalConfigForGuild(guildId) {
        const stat = await fs.stat(this.localPath).catch(() => null)
        if (!stat) return null
        if (stat.isDirectory()) {
            const candidate = path.join(this.localPath, `${guildId}.yaml`)
            const exists = await fs.stat(candidate).catch(() => null)
            if (!exists) return null
            const raw = await fs.readFile(candidate, "utf8")
            return yaml.parse(raw)
        }
        // If localPath is a file, use it as the default configuration.
        return null
    }

    async _loadFromS3(guildId) {
        const key = this._s3KeyForGuild(guildId)
        try {
            const { Body } = await this.s3Client.send(
                new GetObjectCommand({ Bucket: this.s3Bucket, Key: key }),
            )
            const raw = await streamToString(Body)
            return yaml.parse(raw)
        } catch (error) {
            // If object doesn't exist, return null and continue using local config
            if (
                error.name === "NoSuchKey" ||
                error.$metadata?.httpStatusCode === 404
            ) {
                return null
            }
            throw error
        }
    }

    _s3KeyForGuild(guildId) {
        return `${this.s3Prefix}/${guildId}.yaml`
    }

    _s3VersionKeyForGuild(guildId, timestamp) {
        return `${this.s3Prefix}/${guildId}/versions/${timestamp}.yaml`
    }

    getCurrentConfig() {
        return this.defaultConfig
    }

    async getConfig(guildId) {
        if (!guildId) return this.defaultConfig

        const cached = this.configs.get(guildId)
        if (cached) return cached

        // Try local config file per guild
        const local = await this._loadLocalConfigForGuild(guildId)
        if (local) {
            const validated = validateConfig(local)
            this.configs.set(guildId, validated)
            return validated
        }

        // Try S3 config per guild
        if (this.s3Bucket) {
            const s3Config = await this._loadFromS3(guildId)
            if (s3Config) {
                const validated = validateConfig(s3Config)
                this.configs.set(guildId, validated)
                return validated
            }
        }

        // Fallback to default
        return this.defaultConfig
    }

    getSanitizedConfig(config) {
        return sanitizeConfig(config ?? this.defaultConfig)
    }

    async validateCandidateConfig(config) {
        return validateConfig(config)
    }

    async bufferCandidateConfig(guildId, userId, config) {
        const key = `${guildId}:${userId}`
        const validated = await this.validateCandidateConfig(config)
        this.candidates.set(key, { config: validated, timestamp: Date.now() })
        return validated
    }

    peekCandidateConfig(guildId, userId) {
        const key = `${guildId}:${userId}`
        return this.candidates.get(key)
    }

    async applyCandidateConfig(guildId, userId, options = {}) {
        const candidate = this.peekCandidateConfig(guildId, userId)
        if (!candidate) {
            throw new Error(
                "No validated candidate config available. Run /config validate first.",
            )
        }
        const validated = candidate.config
        await this.saveConfig(validated)
        this.configs.set(guildId, validated)
        return { config: validated, candidate }
    }

    async saveConfig(config) {
        const validated = validateConfig(config)
        const guildId = validated.guild?.id

        if (this.s3Bucket && guildId) {
            const key = this._s3KeyForGuild(guildId)
            const asYaml = yaml.stringify(validated)

            // Save the primary config file
            await this.s3Client.send(
                new PutObjectCommand({
                    Bucket: this.s3Bucket,
                    Key: key,
                    Body: asYaml,
                    ContentType: "application/x-yaml",
                }),
            )

            // Save a versioned snapshot
            const versionKey = this._s3VersionKeyForGuild(
                guildId,
                isoTimestamp(),
            )
            await this.s3Client.send(
                new PutObjectCommand({
                    Bucket: this.s3Bucket,
                    Key: versionKey,
                    Body: asYaml,
                    ContentType: "application/x-yaml",
                }),
            )
            return { bucket: this.s3Bucket, key, versionKey }
        }

        // Fallback: write to local config file
        // If localPath is a directory, write per-guild file where possible
        if (guildId) {
            const stat = await fs.stat(this.localPath).catch(() => null)
            if (stat && stat.isDirectory()) {
                const target = path.join(this.localPath, `${guildId}.yaml`)
                const asYaml = yaml.stringify(validated)
                await fs.writeFile(target, asYaml, "utf8")
                return { path: target }
            }
        }

        const asYaml = yaml.stringify(validated)
        await fs.writeFile(this.localPath, asYaml, "utf8")
        return { path: this.localPath }
    }

    async listVersions(guildId, maxKeys = 50) {
        if (!this.s3Bucket) return []
        const prefix = `${this.s3Prefix}/${guildId}/versions/`
        const resp = await this.s3Client.send(
            new ListObjectsV2Command({
                Bucket: this.s3Bucket,
                Prefix: prefix,
                MaxKeys: maxKeys,
            }),
        )

        return (resp.Contents ?? [])
            .map((obj) => ({
                key: obj.Key,
                lastModified: obj.LastModified,
                size: obj.Size,
            }))
            .sort(
                (a, b) =>
                    (b.lastModified?.getTime() ?? 0) -
                    (a.lastModified?.getTime() ?? 0),
            )
    }

    async loadVersion(guildId, versionKey) {
        if (!this.s3Bucket) return null
        const resp = await this.s3Client.send(
            new GetObjectCommand({ Bucket: this.s3Bucket, Key: versionKey }),
        )
        const raw = await streamToString(resp.Body)
        return yaml.parse(raw)
    }
}
