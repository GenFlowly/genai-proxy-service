import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {InterfaceVpcEndpointAwsService, Vpc} from 'aws-cdk-lib/aws-ec2';
import { ALLOWED_HTTPS_PORT, ASG_CAPACITY, createDefaultVpc, STAGES } from "@genflowly/cdk-commons";
import {IRepository, Repository} from "aws-cdk-lib/aws-ecr";

export interface EcsStackProps extends cdk.StackProps {
  serviceName: string;
  stage: STAGES;
  ecrRepo: IRepository
}

export class EcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const maxAzs: number = ASG_CAPACITY.MAX;
    const vpcName = `${props.serviceName}-${props.stage}-vpc`;
    const clusterName = `${props.serviceName}-${props.stage}-cluster`;
    const repositoryName = `${props.serviceName}-${props.stage}-repo`;
    const containerName = `${props.serviceName}-${props.stage}-container`;
    const logGroupName = `${props.serviceName}-${props.stage}-log-group`;

    const vpc: Vpc = createDefaultVpc(
      this,
      `${props.serviceName}-${props.stage}-VpcId`,
      vpcName,
      maxAzs,
      props.stage,
      true
    );


      vpc.addInterfaceEndpoint('EcrApiEndpoint', {
          service: InterfaceVpcEndpointAwsService.ECR,
      });
      vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
          service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
      });
      vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
          service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      });

    const cluster = new ecs.Cluster(
      this, `${props.serviceName}-${props.stage}-clusterId`, {
      vpc,
      clusterName
    });

      const imageTag = process.env.IMAGE_TAG || "8d956bc";

      // Fargate Service + ALB
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      `${props.serviceName}-${props.stage}-ServiceId`,
      {
        cluster,
        serviceName: `${props.serviceName}-${props.stage}`,
        desiredCount: 2,
        cpu: 512,
        memoryLimitMiB: 1024,
        taskImageOptions: {
          image: ecs.ContainerImage.fromEcrRepository(props.ecrRepo, imageTag),
          containerName,
          containerPort: 8080,
        },
        capacityProviderStrategies: [
          { capacityProvider: 'FARGATE_SPOT', weight: 1 },
        ],
        publicLoadBalancer: true,
      },
    );

    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'EcsServiceName', { value: fargateService.service.serviceName });
    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });


  }
}
