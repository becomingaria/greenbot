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
        remember: Joi.boolean().default(true),
        reminders: Joi.boolean().default(true),
    }).default(),

    remember: Joi.object({
        // Number of days without access before a remembered item is forgotten.
        forgetAfterDays: Joi.number().integer().min(1).default(30),
        // How many days before forgetting to warn in the configured admin channel.
        warnBeforeDays: Joi.number().integer().min(1).default(10),
    }).default(),

    reminders: Joi.object({
        // How often to check for due reminders / remember warnings (seconds).
        checkIntervalSeconds: Joi.number().integer().min(10).default(60),
        // How long to keep reminder items after they are due (days).
        keepSentDays: Joi.number().integer().min(1).default(7),
    }).default(),

    subjects: Joi.object({
        defaultChannels: Joi.array()
            .items(
                Joi.object({
                    name: Joi.string().required(),
                    type: Joi.string()
                        .valid("text", "voice", "forum")
                        .default("text"),
                    locked: Joi.boolean().default(false),
                }),
            )
            .default([]),
        rolePrefix: Joi.string().default(""),
        createRoleOnSubject: Joi.boolean().default(true),
        archiveCategoryId: Joi.string().allow("").default(""),
        archiveRenamePrefix: Joi.string().default("archived-"),
    }).default(),

    moderation: Joi.object({
        excludedChannelIds: Joi.array().items(Joi.string()).default([]),
        bannedPhrases: Joi.array().items(Joi.string()).default([]),
        links: Joi.object({
            enabled: Joi.boolean().default(true),
            allowlistDomains: Joi.array().items(Joi.string()).default([]),
            blockUnknownDomains: Joi.boolean().default(false),
        }).default(),
        spam: Joi.object({
            enabled: Joi.boolean().default(true),
            maxMessagesPerWindow: Joi.number().integer().default(6),
            windowSeconds: Joi.number().integer().default(10),
            action: Joi.string()
                .valid("warn", "delete", "timeout", "ban")
                .default("warn"),
            timeoutSeconds: Joi.number().integer().default(600),
        }).default(),
        strikes: Joi.object({
            enabled: Joi.boolean().default(true),
            thresholds: Joi.object().pattern(
                Joi.string().regex(/^\d+$/),
                Joi.object({
                    action: Joi.string()
                        .valid("warn", "delete", "timeout", "ban")
                        .required(),
                    timeoutSeconds: Joi.number().integer().optional(),
                    deleteMessageDays: Joi.number().integer().optional(),
                }),
            ),
        }).default(),
        dryRun: Joi.boolean().default(false),
    }).default(),

    qa: Joi.object({
        enabled: Joi.boolean().default(true),
        defaultMode: Joi.string()
            .valid("contains", "exact", "regex")
            .default("contains"),
        rules: Joi.array()
            .items(
                Joi.object({
                    trigger: Joi.string().required(),
                    mode: Joi.string().valid("contains", "exact", "regex"),
                    response: Joi.string().required(),
                    channelIds: Joi.array().items(Joi.string()).default([]),
                    cooldownSeconds: Joi.number().integer().default(10),
                }),
            )
            .default([]),
    }).default(),

    safeActions: Joi.object({
        actions: Joi.object().pattern(
            Joi.string(),
            Joi.object({
                description: Joi.string().default(""),
                steps: Joi.array().items(
                    Joi.object({
                        op: Joi.string().required(),
                        name: Joi.string().optional(),
                        category: Joi.string().optional(),
                        channel: Joi.string().optional(),
                        type: Joi.string()
                            .valid("text", "voice", "forum")
                            .optional(),
                        content: Joi.string().optional(),
                        role: Joi.string().optional(),
                    }),
                ),
            }),
        ),
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
    return validateConfig(config)
}

export function validateConfig(config) {
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
