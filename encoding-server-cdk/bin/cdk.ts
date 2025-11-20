#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { STAGES } from '@genflowly/cdk-commons';
import { EcrStack } from "../lib/ecr-stack";
import { S3Stack } from "../lib/s3-stack";
import { SqsStack } from "../lib/sqs-stack";
import { LambdaStack } from "../lib/lambda-stack";
import { ApiGatewayStack } from "../lib/apigateway-stack";

const stage: STAGES = STAGES.BETA;

const app = new cdk.App();

const ecrStack = new EcrStack(app, 'EcrStack', { stage });
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
