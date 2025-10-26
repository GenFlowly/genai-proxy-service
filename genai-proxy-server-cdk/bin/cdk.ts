#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {DynamoDBStack} from '../lib/dynamodb-stack';
import {STAGES} from '@genflowly/cdk-commons';
import {EcsStack} from "../lib/ecs-stack";
import {EcrStack} from "../lib/ecr-stack";
import {
    OneTimeDeploymentPerStageStack
} from "../lib/oneTimeDeploymentPerStage-stack";
import {KmsStack} from "../lib/kms-stack";

const serviceName: string = 'gen-ai-proxy-service';
const stage: STAGES = STAGES.BETA;
const rootDomain: string = 'genflowly.com';

const app = new cdk.App();

new OneTimeDeploymentPerStageStack(app, 'BootstrapStack', {stage})

const dynamoDBStack = new DynamoDBStack(app, 'DynamoDBStack', {});
const ecrStack = new EcrStack(app, 'EcrStack', {serviceName, stage});
const kmsStack = new KmsStack(app, 'KmsStack', {serviceName, stage})
new EcsStack(app, 'EcsStack', {
    serviceName,
    stage,
    ecrRepo: ecrStack.repository,
    dynamoDbTableList: dynamoDBStack.dynamoDbTableList,
    kmsKey: kmsStack.kmsKey,
    domainName: rootDomain,
    subdomain: 'api',
    certificateArn: 'arn:aws:acm:us-east-1:571600870493:certificate/d4d0dac3-8ed7-4ab2-90aa-ed22d8c1c39f',
});
