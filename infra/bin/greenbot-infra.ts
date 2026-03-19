#!/usr/bin/env node
import "source-map-support/register"
import * as cdk from "aws-cdk-lib"
import { GreenBotStack } from "../lib/greenbot-stack"

const app = new cdk.App()

// Pass --context budgetEmail=you@example.com to enable the budget alert email.
const budgetAlertEmail = app.node.tryGetContext("budgetEmail") as
    | string
    | undefined

new GreenBotStack(app, "GreenBotStack", {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: "us-east-1",
    },
    budgetAlertEmail,
})
