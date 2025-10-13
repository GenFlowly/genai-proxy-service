import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { ALLOWED_HTTPS_PORT, ASG_CAPACITY, createDefaultVpc, STAGES } from "@genflowly/cdk-commons";
import {IRepository} from "aws-cdk-lib/aws-ecr";

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
    const LATEST_TAG = 'latest';

    const vpc: Vpc = createDefaultVpc(
      this,
      `${props.serviceName}-${props.stage}-VpcId`,
      vpcName,
      maxAzs,
      props.stage,
      true
    );

    const cluster = new ecs.Cluster(
      this, `${props.serviceName}-${props.stage}-clusterId`, {
      vpc,
      clusterName
    });

    const logGroup = new logs.LogGroup(this, `${props.serviceName}-${props.stage}-logGroupId`, {
      logGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
          image: ecs.ContainerImage.fromEcrRepository(props.ecrRepo, LATEST_TAG),
          containerName,
          containerPort: 8080,
          logDriver: ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: props.serviceName,
          }),
          environment: {
            ENV: props.stage,
            PORT: '8080',
          },
        },
        publicLoadBalancer: true,
        healthCheckGracePeriod: cdk.Duration.seconds(60),
      }
    );

    // Health Check
    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // Autoscaling
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 2,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 90,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 90,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Grant pull permissions for ECS
    ecrRepo.grantPull(fargateService.taskDefinition.executionRole!);

    // Outputs for GitHub Actions
    new cdk.CfnOutput(this, 'ECRRepositoryName', {
      value: repositoryName,
      exportName: `${props.serviceName}-ECRRepositoryName`,
    });

    new cdk.CfnOutput(this, 'ECRRepositoryURI', {
      value: ecrRepo.repositoryUri,
      exportName: `${props.serviceName}-ECRRepositoryURI`,
    });

    new cdk.CfnOutput(this, 'ECSClusterName', {
      value: cluster.clusterName,
      exportName: `${props.serviceName}-ECSClusterName`,
    });

    new cdk.CfnOutput(this, 'ECSServiceName', {
      value: fargateService.service.serviceName,
      exportName: `${props.serviceName}-ECSServiceName`,
    });

    new cdk.CfnOutput(this, 'AWSRegion', {
      value: this.region,
      exportName: `${props.serviceName}-AWSRegion`,
    });

    new cdk.CfnOutput(this, 'ServiceURL', {
      value: `http://${fargateService.loadBalancer.loadBalancerDnsName}`,
      description: 'Public URL of the service',
    });
  }
}
