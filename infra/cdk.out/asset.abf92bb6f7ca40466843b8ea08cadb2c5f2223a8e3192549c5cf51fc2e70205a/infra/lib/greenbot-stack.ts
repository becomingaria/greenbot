import * as path from "path"
import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ssm from "aws-cdk-lib/aws-ssm"
import * as s3 from "aws-cdk-lib/aws-s3"

export interface GreenBotStackProps extends cdk.StackProps {
    /**
     * SSM parameter name that stores the Discord bot token.
     * If the param does not exist, a placeholder will be created (you should replace it with a real token).
     */
    readonly discordTokenParameterName?: string
    /**
     * Bucket name prefix for config storage.
     * If not provided, a generated bucket will be used.
     */
    readonly configBucketPrefix?: string
}

export class GreenBotStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: GreenBotStackProps = {}) {
        super(scope, id, props)

        const tokenParamName =
            props.discordTokenParameterName || "/greenbot/discord-token"

        // Ensure there is a token parameter in SSM (with a placeholder default).
        // For production, store the real token in a SecureString parameter.
        const tokenParam = new ssm.StringParameter(this, "DiscordTokenParam", {
            parameterName: tokenParamName,
            stringValue: "<REPLACE_WITH_DISCORD_TOKEN>",
            description:
                "Discord bot token (secret; update with your real token in SSM Parameter Store).",
            tier: ssm.ParameterTier.STANDARD,
        })

        const vpc = new ec2.Vpc(this, "GreenBotVpc", {
            maxAzs: 2,
        })

        const cluster = new ecs.Cluster(this, "GreenBotCluster", {
            vpc,
            clusterName: "greenbot",
        })

        // Create a minimal S3 bucket for config/version storage.
        const configBucket = new s3.Bucket(this, "GreenBotConfigBucket", {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        })

        const taskRole = new iam.Role(this, "GreenBotTaskRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        })

        // Allow the task to read the Discord token and read/write config.
        tokenParam.grantRead(taskRole)
        configBucket.grantReadWrite(taskRole)

        const executionRole = new iam.Role(this, "GreenBotExecutionRole", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy",
                ),
            ],
        })

        const fargateService =
            new ecs_patterns.ApplicationLoadBalancedFargateService(
                this,
                "GreenBotService",
                {
                    cluster,
                    cpu: 256,
                    memoryLimitMiB: 512,
                    desiredCount: 1,
                    taskImageOptions: {
                        image: ecs.ContainerImage.fromAsset(
                            path.join(__dirname, "../../"),
                            {
                                // Exclude generated artifacts (especially cdk.out) so we don't recursively
                                // include the CDK staging folder in the Docker build context.
                                exclude: [
                                    "**/cdk.out/**",
                                    "infra/cdk.out/**",
                                    "node_modules/**",
                                    ".git/**",
                                ],
                            },
                        ),
                        containerName: "greenbot",
                        environment: {
                            // These env vars are used by the runtime.
                            // `DISCORD_TOKEN` is provided via SSM token parameter (read at runtime by the app).
                            // Keep token out of CloudFormation secrets by reading it at runtime.
                            CONFIG_PATH: "/usr/src/app/config/config.yaml",
                        },
                        taskRole,
                        executionRole,
                    },
                    publicLoadBalancer: true,
                },
            )

        // Provide the SSM parameter name and config bucket as environment variables.
        fargateService.taskDefinition.defaultContainer?.addEnvironment(
            "DISCORD_TOKEN_SSM_PARAM",
            tokenParam.parameterName,
        )
        fargateService.taskDefinition.defaultContainer?.addEnvironment(
            "CONFIG_S3_BUCKET",
            configBucket.bucketName,
        )

        new cdk.CfnOutput(this, "LoadBalancerDNS", {
            value: fargateService.loadBalancer.loadBalancerDnsName,
        })

        new cdk.CfnOutput(this, "ConfigBucket", {
            value: configBucket.bucketName,
        })

        new cdk.CfnOutput(this, "DiscordTokenParameter", {
            value: tokenParam.parameterName,
        })
    }
}
