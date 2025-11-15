import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import {Construct} from 'constructs';
import {
    InterfaceVpcEndpointAwsService,
    Vpc
} from 'aws-cdk-lib/aws-ec2';
import {
    ASG_CAPACITY,
    createDefaultVpc,
    STAGES
} from "@genflowly/cdk-commons";
import {IRepository} from "aws-cdk-lib/aws-ecr";
import {ITable} from "aws-cdk-lib/aws-dynamodb";
import {IKey} from "aws-cdk-lib/aws-kms";
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

export interface EcsStackProps extends cdk.StackProps {
    serviceName: string;
    stage: STAGES;
    ecrRepo: IRepository,
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
        const vpcName = `${props.serviceName}-${props.stage}-vpc`;
        const clusterName = `${props.serviceName}-${props.stage}-cluster`;
        const containerName = `${props.serviceName}-${props.stage}-container`;

        const vpc: Vpc = createDefaultVpc(
            this,
            `${props.serviceName}-${props.stage}-VpcId`,
            vpcName,
            maxAzs,
            props.stage,
            true
        );

        vpc.addGatewayEndpoint('S3Endpoint', {
            service: InterfaceVpcEndpointAwsService.S3,
        });


        const cluster = new ecs.Cluster(
            this, `${props.serviceName}-${props.stage}-clusterId`, {
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
            domainNameFull = `${props.subdomain}-${props.stage}.${props.domainName}`;
            certificate = acm.Certificate.fromCertificateArn(
                this,
                'ImportedCertificate',
                props.certificateArn
            );
        }

        const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
            this,
            `${props.serviceName}-${props.stage}-ServiceId`,
            {
                cluster,
                serviceName: `${props.serviceName}-${props.stage}`,
                desiredCount: 1,
                cpu: 256,
                memoryLimitMiB: 512,
                publicLoadBalancer: true,
                assignPublicIp: true,
                certificate,
                taskImageOptions: {
                    image: ecs.ContainerImage.fromEcrRepository(props.ecrRepo, imageTag),
                    containerName,
                    containerPort: 8080,
                    enableLogging: true,
                    environment: {
                        AUTH0_SPA_DOMAIN: process.env.AUTH0_SPA_DOMAIN ?? '',
                        AUTH0_SPA_CLIENT_ID: process.env.AUTH0_SPA_CLIENT_ID ?? '',
                        AUTH0_API_AUDIENCE: process.env.AUTH0_API_AUDIENCE ?? '',
                        KMS_KEY_ID: props.kmsKey.keyArn,
                    },
                },
                capacityProviderStrategies: [
                    { capacityProvider: 'FARGATE_SPOT', weight: 1 },
                ],
            }
        );

        props.dynamoDbTableList.forEach((it) =>
            it.grantReadWriteData(fargateService.taskDefinition.taskRole));

        props.kmsKey.grantEncryptDecrypt(fargateService.taskDefinition.taskRole);

        fargateService.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');
        fargateService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');

        new cdk.CfnOutput(this, 'EcsClusterName', {value: cluster.clusterName});
        new cdk.CfnOutput(this, 'EcsServiceName', {value: fargateService.service.serviceName});
        new cdk.CfnOutput(this, 'LoadBalancerDNS', {value: fargateService.loadBalancer.loadBalancerDnsName});
        if (domainNameFull) {
            new cdk.CfnOutput(this, 'CustomDomain', { value: domainNameFull });
        }
    }
}
