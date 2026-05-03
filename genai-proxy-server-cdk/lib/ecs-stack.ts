import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
    GatewayVpcEndpointAwsService,
    Vpc
} from 'aws-cdk-lib/aws-ec2';
import {
    ASG_CAPACITY,
    createDefaultVpc,
    STAGES
} from "@genflowly/cdk-commons";
import { IRepository } from "aws-cdk-lib/aws-ecr";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { IKey } from "aws-cdk-lib/aws-kms";
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { RESOURCE_NAMES } from "./constants";

export interface EcsStackProps extends cdk.StackProps {
    stage: STAGES;
    proxyEcrRepo: IRepository;
    retrievalEcrRepo: IRepository;
    dynamoDbTableList: ITable[];
    kmsKey: IKey;
    domainName?: string;
    subdomain?: string;
    certificateArn?: string;
}

export class EcsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EcsStackProps) {
        super(scope, id, props);

        const maxAzs: number = ASG_CAPACITY.MAX;
        const vpcName = `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-vpc`;
        const clusterName = `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-cluster`;
        const containerName = `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-container`;

        const vpc: Vpc = createDefaultVpc(
            this,
            `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-VpcId`,
            vpcName,
            maxAzs,
            props.stage,
            true
        );

        vpc.addGatewayEndpoint('S3Endpoint', {
            service: GatewayVpcEndpointAwsService.S3,
        });


        const cluster = new ecs.Cluster(
            this, `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-clusterId`, {
            clusterName,
            vpc,
        });

        const requiredEnvVars = ['AUTH0_SPA_DOMAIN', 'AUTH0_SPA_CLIENT_ID', 'AUTH0_API_AUDIENCE'];
        for (const key of requiredEnvVars) {
            if (!process.env[key]) {
                throw new Error(`Missing required environment variable: ${key}`);
            }
        }

        const imageTag = process.env.IMAGE_TAG;

        let domainNameFull: string | undefined = undefined;
        let certificate: acm.ICertificate | undefined = undefined;

        if (props.domainName && props.subdomain && props.certificateArn) {
            domainNameFull = props.stage === STAGES.PROD
                ? `${props.subdomain}.${props.domainName}`
                : `${props.subdomain}-${props.stage}.${props.domainName}`;
            certificate = acm.Certificate.fromCertificateArn(
                this,
                'ImportedCertificate',
                props.certificateArn
            );
        }

        const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
            this,
            `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}-ServiceId`,
            {
                cluster,
                serviceName: `${RESOURCE_NAMES.GEN_AI_PROXY_SERVICE}-${props.stage}`,
                desiredCount: 1,
                cpu: 2048,
                memoryLimitMiB: 4096,
                publicLoadBalancer: true,
                assignPublicIp: true,
                certificate,
                taskImageOptions: {
                    image: ecs.ContainerImage.fromEcrRepository(props.proxyEcrRepo, imageTag),
                    containerName,
                    containerPort: 8080,
                    enableLogging: true,
                    environment: {
                        AUTH0_SPA_DOMAIN: process.env.AUTH0_SPA_DOMAIN ?? '',
                        AUTH0_SPA_CLIENT_ID: process.env.AUTH0_SPA_CLIENT_ID ?? '',
                        AUTH0_API_AUDIENCE: process.env.AUTH0_API_AUDIENCE ?? '',
                        KMS_KEY_ID: props.kmsKey.keyArn,
                        RETRIEVAL_SERVER_URL: 'http://localhost:5001'
                    },
                },
                capacityProviderStrategies: [
                    { capacityProvider: 'FARGATE_SPOT', weight: 1 },
                ],
                redirectHTTP: true,
            }
        );

        fargateService.taskDefinition.addContainer('RetrievalContainer', {
            image: ecs.ContainerImage.fromEcrRepository(props.retrievalEcrRepo, imageTag),
            containerName: 'retrieval-server',
            portMappings: [{ containerPort: 5001 }],
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'retrieval-server' }),
        });

        props.dynamoDbTableList.forEach((it) =>
            it.grantReadWriteData(fargateService.taskDefinition.taskRole));

        // Transitional: grant access to legacy tables via name (not cross-stack ref) so
        // ECS no longer imports their ARN exports from the DDB stack. Remove after Step 2.
        ['CustomerAgents', 'CustomerFlows'].forEach(tableName => {
            dynamodb.Table.fromTableName(this, `${tableName}LegacyRef`, tableName)
                .grantReadWriteData(fargateService.taskDefinition.taskRole);
        });

        props.kmsKey.grantEncryptDecrypt(fargateService.taskDefinition.taskRole);

        // Allow Fargate tasks to invoke the Encoding Lambda
        fargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: ['*'], // Can be scoped down to just the specific lambda ARN if passed in via props
        }));

        // Configure auto scaling
        // Note: AWS ECS auto scaling with ALB metrics doesn't support minCapacity: 0
        // The service will scale between 1-2 tasks based on load
        const scaling = fargateService.service.autoScaleTaskCount({
            minCapacity: 1,  // AWS limitation: cannot scale to 0 with ALB-based scaling
            maxCapacity: 2,  // Scale up to 2 tasks under load
        });

        // Scale based on ALB request count
        scaling.scaleOnRequestCount('RequestScaling', {
            requestsPerTarget: 100,  // Target 100 requests per task
            targetGroup: fargateService.targetGroup,
            scaleInCooldown: cdk.Duration.seconds(300),   // Wait 5 min before scaling down
            scaleOutCooldown: cdk.Duration.seconds(60),   // Wait 1 min before scaling up
        });

        fargateService.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');
        fargateService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');

        new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
        new cdk.CfnOutput(this, 'EcsServiceName', { value: fargateService.service.serviceName });
        new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });
        if (domainNameFull) {
            new cdk.CfnOutput(this, 'CustomDomain', { value: domainNameFull });
        }
    }
}
