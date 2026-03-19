#!/usr/bin/env node
import "source-map-support/register"
import * as cdk from "aws-cdk-lib"
import { GreenBotStack } from "../lib/greenbot-stack"

const app = new cdk.App()
new GreenBotStack(app, "GreenBotStack", {
    /*
     * If you want to override account/region at deploy time, set
     * `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`.
     */
})
