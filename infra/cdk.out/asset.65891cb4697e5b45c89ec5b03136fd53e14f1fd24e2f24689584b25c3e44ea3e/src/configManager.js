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
        this.config = null
        this.candidates = new Map() // key: `${guildId}:${userId}` -> { config, timestamp }
    }

    async init() {
        const local = await this._loadLocalConfig()
        this.config = validateConfig(local)

        if (this.s3Bucket && this.config.guild?.id) {
            const s3Config = await this._loadFromS3(this.config.guild.id)
            if (s3Config) {
                this.config = validateConfig(s3Config)
            }
        }

        return this.config
    }

    async _loadLocalConfig() {
        const raw = await fs.readFile(this.localPath, "utf8")
        return yaml.parse(raw)
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

    async getCurrentConfig() {
        return this.config
    }

    getSanitizedConfig() {
        return sanitizeConfig(this.config)
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
        this.config = validated
        return { config: validated, candidate }
    }

    async saveConfig(config) {
        const validated = validateConfig(config)

        if (this.s3Bucket && validated.guild?.id) {
            const guildId = validated.guild.id
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
