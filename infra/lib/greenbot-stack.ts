import * as path from "path"
import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ssm from "aws-cdk-lib/aws-ssm"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as s3assets from "aws-cdk-lib/aws-s3-assets"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import * as budgets from "aws-cdk-lib/aws-budgets"
import * as scheduler from "aws-cdk-lib/aws-scheduler"

export interface GreenBotStackProps extends cdk.StackProps {
    /** SSM parameter name that stores the Discord bot token. */
    readonly discordTokenParameterName?: string
    /** Email address for the $8/month budget alert (optional). */
    readonly budgetAlertEmail?: string
}

export class GreenBotStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: GreenBotStackProps = {}) {
        super(scope, id, props)

        const tokenParamName =
            props.discordTokenParameterName ?? "/greenbot/discord-token"

        // ── SSM token param (placeholder; replace manually after deploy) ───────
        const tokenParam = new ssm.StringParameter(this, "DiscordTokenParam", {
            parameterName: tokenParamName,
            stringValue: "<REPLACE_WITH_DISCORD_TOKEN>",
            description:
                "Discord bot token — update via SSM before starting bot",
            tier: ssm.ParameterTier.STANDARD,
        })

        // ── S3 config bucket (with 90-day lifecycle) ───────────────────────────
        const configBucket = new s3.Bucket(this, "GreenBotConfigBucket", {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            versioned: true,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(90),
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
            ],
        })

        // ── DynamoDB state table ───────────────────────────────────────────────
        const stateTable = new dynamodb.Table(this, "GreenBotStateTable", {
            partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: "expiresAt",
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        })

        // ── Bundle source → S3 asset (node_modules excluded; installed on EC2) ─
        const codeAsset = new s3assets.Asset(this, "GreenbotCode", {
            path: path.join(__dirname, "../../"),
            exclude: [
                "**/cdk.out/**",
                "infra/**",
                "**/node_modules/**",
                "**/.git/**",
            ],
        })

        // ── IAM instance role ──────────────────────────────────────────────────
        const instanceRole = new iam.Role(this, "GreenBotInstanceRole", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                // Enables SSH-free access via AWS Systems Manager Session Manager
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "AmazonSSMManagedInstanceCore",
                ),
            ],
        })
        tokenParam.grantRead(instanceRole)
        configBucket.grantReadWrite(instanceRole)
        stateTable.grantReadWriteData(instanceRole)
        codeAsset.grantRead(instanceRole)

        // ── Default VPC (no NAT gateway cost) ─────────────────────────────────
        const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true })

        // ── Security group — outbound only (Discord uses outbound WebSocket) ───
        const sg = new ec2.SecurityGroup(this, "GreenBotSG", {
            vpc,
            description: "GreenBot EC2 - outbound only",
            allowAllOutbound: true,
        })

        // ── UserData: install Node 20 + deps, write .env, start systemd service
        const userData = ec2.UserData.forLinux()
        userData.addCommands(
            "set -e",
            // nodejs20 is in the AL2023 default repo — no extra setup needed
            "dnf install -y nodejs20 unzip",
            "mkdir -p /opt/greenbot",
            // Download source bundle from CDK asset bucket
            `aws s3 cp s3://${codeAsset.s3BucketName}/${codeAsset.s3ObjectKey} /tmp/greenbot.zip`,
            "unzip -o /tmp/greenbot.zip -d /opt/greenbot",
            "cd /opt/greenbot && npm install --omit=dev 2>&1 | tee /var/log/greenbot-install.log",
            // Write environment file
            `cat > /opt/greenbot/.env << 'ENVEOF'
DISCORD_TOKEN_SSM_PARAM=${tokenParamName}
CONFIG_S3_BUCKET=${configBucket.bucketName}
DYNAMODB_TABLE_NAME=${stateTable.tableName}
AWS_REGION=${this.region}
CONFIG_PATH=/opt/greenbot/config/config.yaml
ENVEOF`,
            // systemd service unit
            `cat > /etc/systemd/system/greenbot.service << 'SVCEOF'
[Unit]
Description=GreenBot Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/greenbot
EnvironmentFile=/opt/greenbot/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF`,
            "systemctl daemon-reload",
            "systemctl enable greenbot",
            "systemctl start greenbot",
        )

        // ── EC2 t4g.nano (Graviton2 arm64) ────────────────────────────────────
        const instance = new ec2.Instance(this, "GreenBotInstance", {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T4G,
                ec2.InstanceSize.NANO,
            ),
            machineImage: new ec2.AmazonLinuxImage({
                generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
                cpuType: ec2.AmazonLinuxCpuType.ARM_64,
            }),
            role: instanceRole,
            securityGroup: sg,
            userData,
            userDataCausesReplacement: true,
            associatePublicIpAddress: true,
        })

        // ── EventBridge Scheduler: stop at 11 PM / start at 9 AM Pacific ──────
        const schedulerRole = new iam.Role(this, "SchedulerRole", {
            assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
        })
        schedulerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["ec2:StopInstances", "ec2:StartInstances"],
                resources: [
                    `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
                ],
            }),
        )

        // Stop at 11:00 PM Pacific (handles DST via timezone field)
        new scheduler.CfnSchedule(this, "StopSchedule", {
            scheduleExpression: "cron(0 23 * * ? *)",
            scheduleExpressionTimezone: "America/Los_Angeles",
            flexibleTimeWindow: { mode: "OFF" },
            target: {
                arn: "arn:aws:scheduler:::aws-sdk:ec2:stopInstances",
                roleArn: schedulerRole.roleArn,
                input: JSON.stringify({ InstanceIds: [instance.instanceId] }),
            },
        })

        // Start at 9:00 AM Pacific
        new scheduler.CfnSchedule(this, "StartSchedule", {
            scheduleExpression: "cron(0 9 * * ? *)",
            scheduleExpressionTimezone: "America/Los_Angeles",
            flexibleTimeWindow: { mode: "OFF" },
            target: {
                arn: "arn:aws:scheduler:::aws-sdk:ec2:startInstances",
                roleArn: schedulerRole.roleArn,
                input: JSON.stringify({ InstanceIds: [instance.instanceId] }),
            },
        })

        // ── $8/month budget alert ──────────────────────────────────────────────
        new budgets.CfnBudget(this, "MonthlyBudget", {
            budget: {
                budgetType: "COST",
                timeUnit: "MONTHLY",
                budgetLimit: { amount: 8, unit: "USD" },
                budgetName: "greenbot-monthly",
            },
            notificationsWithSubscribers: props.budgetAlertEmail
                ? [
                      {
                          notification: {
                              notificationType: "ACTUAL",
                              comparisonOperator: "GREATER_THAN",
                              threshold: 100,
                              thresholdType: "PERCENTAGE",
                          },
                          subscribers: [
                              {
                                  subscriptionType: "EMAIL",
                                  address: props.budgetAlertEmail,
                              },
                          ],
                      },
                  ]
                : [],
        })

        // ── Outputs ────────────────────────────────────────────────────────────
        new cdk.CfnOutput(this, "InstanceId", {
            value: instance.instanceId,
            description: "EC2 instance ID",
        })
        new cdk.CfnOutput(this, "ConfigBucket", {
            value: configBucket.bucketName,
        })
        new cdk.CfnOutput(this, "StateTableName", {
            value: stateTable.tableName,
        })
        new cdk.CfnOutput(this, "DiscordTokenParameter", {
            value: tokenParam.parameterName,
        })
    }
}
