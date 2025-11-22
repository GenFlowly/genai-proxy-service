#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { STAGES } from '@genflowly/cdk-commons';
import { EcrStack } from "../lib/ecr-stack";
import { S3Stack } from "../lib/s3-stack";
import { SqsStack } from "../lib/sqs-stack";
import { LambdaStack } from "../lib/lambda-stack";
import { ApiGatewayStack } from "../lib/apigateway-stack";
import { RESOURCE_NAMES } from "../lib/constants";

const stage: STAGES = STAGES.BETA;

const app = new cdk.App();

const ecrStack = new EcrStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-EcrStack`, { stage });
const s3Stack = new S3Stack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-S3Stack`, { stage });
const sqsStack = new SqsStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-SqsStack`, { stage });
const lambdaStack = new LambdaStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-LambdaStack`, {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    rawEmailBucket: s3Stack.rawEmailBucket,
    processingRepo: ecrStack.processingRepository,
});
const apiGatewayStack = new ApiGatewayStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-ApiGatewayStack`, {
    stage,
    ingestionLambda: lambdaStack.ingestionLambda,
    auth0Domain: process.env.AUTH0_SPA_DOMAIN || 'dev-abh5z7416lwy3xhv.us.auth0.com', // Fallback for local dev if needed
});
