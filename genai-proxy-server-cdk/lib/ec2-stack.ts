import * as cdk from 'aws-cdk-lib';
import {
  addIPv6IngressRule,
  ALLOWED_HTTP_PORT,
  ASG_CAPACITY,
  createDefaultSecurityGroup,
  createIpv6Ec2Instance,
  createIpv6Vpc,
  STAGES,
  T2_NANO,
} from '@genflowly/cdk-commons';
import { Construct } from 'constructs';
import { Instance, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ALLOWED_HTTPS_PORT } from '@genflowly/cdk-commons';

export interface Ec2StackStackProps extends cdk.StackProps {
  serviceName: string;
  stage: STAGES;
}

export class Ec2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Ec2StackStackProps) {
    super(scope, id, props);

    const maxAzs: number = ASG_CAPACITY.MIN;
    const isPublic: boolean = true;
    const vpcId: string = `${props.serviceName}-${props.stage}-vpc`;
    const vpcName: string = `${props.serviceName}-${props.stage}-vpc`;

    const ec2InstanceName: string = `${props.serviceName}-${props.stage}-EC2Instance`;

    const securityGroupName: string = `${props.serviceName}-${props.stage}-SecurityGroup`;
    const securityGroupDescription: string = `${props.serviceName}-${props.stage}-SecurityGroup for VPC: ${vpcName} and EC2 Instance: ${ec2InstanceName} `;

    const vpc: Vpc = createIpv6Vpc(
      this,
      vpcId,
      vpcName,
      maxAzs,
      props.stage,
      true
    );

    const securityGroup: SecurityGroup = createDefaultSecurityGroup(
      this,
      securityGroupName,
      vpc,
      securityGroupDescription,
      props.stage
    );

    const allowedPorts = [ALLOWED_HTTP_PORT, ALLOWED_HTTPS_PORT];

    allowedPorts.forEach((port) => {
      addIPv6IngressRule(
        securityGroup,
        Port.tcp(port),
        `Allow list Port ${port}`
      );
    });

    const ec2Instance: Instance = createIpv6Ec2Instance(
      this,
      ec2InstanceName,
      T2_NANO,
      vpc,
      '',
      props.stage
    );

    new cdk.CfnOutput(this, 'InstanceId', {
      value: ec2Instance.instanceId,
    });
  }
}
