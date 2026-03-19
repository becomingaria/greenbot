import fs from "fs/promises"
import path from "path"
import yaml from "yaml"
import Joi from "joi"
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm"

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config/config.yaml")

const configSchema = Joi.object({
    version: Joi.number().integer().required(),
    guild: Joi.object({
        id: Joi.string().required(),
    }).required(),
    admin: Joi.object({
        controlChannelId: Joi.string().required(),
        allowedUserIds: Joi.array().items(Joi.string()).default([]),
        allowedRoleIds: Joi.array().items(Joi.string()).default([]),
        requireDiscordPermissions: Joi.boolean().default(true),
    }).required(),
    logging: Joi.object({
        level: Joi.string()
            .valid("debug", "info", "warn", "error")
            .default("info"),
        auditChannelId: Joi.string().allow(""),
        redact: Joi.array().items(Joi.string()).default(["token", "secrets"]),
    }).default(),
    features: Joi.object({
        subjects: Joi.boolean().default(true),
        moderation: Joi.boolean().default(true),
        qa: Joi.boolean().default(true),
        safeActions: Joi.boolean().default(true),
        archive: Joi.boolean().default(true),
    }).default(),
}).unknown(true)

export async function loadConfig({ fromSsmParam, path: configPath } = {}) {
    const source = configPath || process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH

    let raw
    if (fromSsmParam || process.env.CONFIG_SSM_PARAM) {
        const paramName = fromSsmParam || process.env.CONFIG_SSM_PARAM
        const client = new SSMClient({})
        const cmd = new GetParameterCommand({
            Name: paramName,
            WithDecryption: true,
        })
        const res = await client.send(cmd)
        raw = res.Parameter?.Value ?? ""
    } else {
        raw = await fs.readFile(source, "utf8")
    }

    const config = yaml.parse(raw)
    const { value, error } = configSchema.validate(config, {
        abortEarly: false,
        allowUnknown: true,
    })
    if (error) {
        const message = error.details.map((d) => d.message).join("; ")
        throw new Error(`Config validation failed: ${message}`)
    }

    return value
}

export function sanitizeConfig(config) {
    const cloned = JSON.parse(JSON.stringify(config))
    const redactPaths = (config.logging?.redact ?? []).map((p) =>
        p.toLowerCase(),
    )

    // Simple recursive sanitizer that replaces values for keys that match redact paths.
    function walk(obj) {
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            for (const [k, v] of Object.entries(obj)) {
                if (redactPaths.includes(k.toLowerCase())) {
                    obj[k] = "<redacted>"
                } else {
                    walk(v)
                }
            }
        }
    }

    walk(cloned)
    return cloned
}
