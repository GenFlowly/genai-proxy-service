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

import { StepFunctionsStack } from "../lib/stepfunctions-stack";

const stage: STAGES = STAGES.BETA;

const app = new cdk.App();

const ecrStack = new EcrStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-EcrStack`, { stage });
const s3Stack = new S3Stack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-S3Stack`, { stage });
const sqsStack = new SqsStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-SqsStack`, { stage });
const lambdaStack = new LambdaStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-LambdaStack`, {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    rawEmailBucket: s3Stack.rawEmailBucket,
    ingestionRepo: ecrStack.ingestionRepo,
    encodeRepo: ecrStack.encodeRepo,
    storeEmbeddingsRepo: ecrStack.storeEmbeddingsRepo,
    storeS3Repo: ecrStack.storeS3Repo,
});

const stepFunctionsStack = new StepFunctionsStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-StepFunctionsStack`, {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    storeS3Repo: ecrStack.storeS3Repo,
    encodeLambda: lambdaStack.encodeLambda,
    storeEmbeddingsLambda: lambdaStack.storeEmbeddingsLambda,
    storeS3Lambda: lambdaStack.storeS3Lambda,
});

const apiGatewayStack = new ApiGatewayStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-ApiGatewayStack`, {
    stage,
    ingestionLambda: lambdaStack.ingestionLambda,
    auth0Domain: 'dev-0e3d96c83ea3190.us.auth0.com', // Fallback for local dev if needed
});
