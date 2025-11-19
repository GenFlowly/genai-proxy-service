#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { STAGES } from '@genflowly/cdk-commons';
import { EcsStack } from "../lib/ecs-stack";
import { EcrStack } from "../lib/ecr-stack";
import {
    OneTimeDeploymentPerStageStack
} from "../lib/oneTimeDeploymentPerStage-stack";
import { KmsStack } from "../lib/kms-stack";
import { S3Stack } from "../lib/s3-stack";
import { SqsStack } from "../lib/sqs-stack";
import { LambdaStack } from "../lib/lambda-stack";
import { ApiGatewayStack } from "../lib/apigateway-stack";

const stage: STAGES = STAGES.BETA;
const rootDomain: string = 'genflowly.com';

const app = new cdk.App();

new OneTimeDeploymentPerStageStack(app, 'BootstrapStack', { stage })

const dynamoDBStack = new DynamoDBStack(app, 'DynamoDBStack', {});
const ecrStack = new EcrStack(app, 'EcrStack', { stage });
const kmsStack = new KmsStack(app, 'KmsStack', { stage })
new EcsStack(app, 'EcsStack', {
    stage,
    ecrRepo: ecrStack.repository,
    dynamoDbTableList: dynamoDBStack.dynamoDbTableList,
    kmsKey: kmsStack.kmsKey,
    domainName: rootDomain,
    subdomain: 'api',
    certificateArn: 'arn:aws:acm:us-east-1:571600870493:certificate/194b5a31-3d3a-4436-bb19-045294e9c25a',
});

const s3Stack = new S3Stack(app, 'S3Stack', { stage });
const sqsStack = new SqsStack(app, 'SqsStack', { stage });
const lambdaStack = new LambdaStack(app, 'LambdaStack', {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    rawEmailBucket: s3Stack.rawEmailBucket,
    processingRepo: ecrStack.processingRepository,
});
const apiGatewayStack = new ApiGatewayStack(app, 'ApiGatewayStack', {
    stage,
    ingestionLambda: lambdaStack.ingestionLambda,
});
