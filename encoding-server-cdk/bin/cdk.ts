#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { STAGES } from '@genflowly/cdk-commons';
import { EcrStack } from "../lib/ecr-stack";
import { S3Stack } from "../lib/s3-stack";
import { SqsStack } from "../lib/sqs-stack";
import { LambdaStack } from "../lib/lambda-stack";
import { ApiGatewayStack } from "../lib/apigateway-stack";
import { DynamoDBStack } from "../lib/dynamodb-stack";
import { RESOURCE_NAMES } from "../lib/constants";

import { StepFunctionsStack } from "../lib/stepfunctions-stack";

const stage: STAGES = STAGES.BETA;

const app = new cdk.App();

const ecrStack = new EcrStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-EcrStack`, { stage });
const s3Stack = new S3Stack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-S3Stack`, { stage });
const sqsStack = new SqsStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-SqsStack`, { stage });
const dynamoDBStack = new DynamoDBStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-DynamoDBStack`, { stage });
const lambdaStack = new LambdaStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-LambdaStack`, {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    rawEmailBucket: s3Stack.rawEmailBucket,
    ingestionRepo: ecrStack.ingestionRepo,
    encodeRepo: ecrStack.encodeRepo,
    storeEmbeddingsRepo: ecrStack.storeEmbeddingsRepo,
    storeS3Repo: ecrStack.storeS3Repo,
    ingestionImageTag: process.env.INGESTION_IMAGE_TAG || 'latest',
    encodeImageTag: process.env.ENCODE_IMAGE_TAG || 'latest',
    storeEmbeddingsImageTag: process.env.STORE_EMBEDDINGS_IMAGE_TAG || 'latest',
    storeS3ImageTag: process.env.STORE_S3_IMAGE_TAG || 'latest',
    zillizEndpoint: process.env.ZILLIZ_ENDPOINT || 'dummy_zilliz_endpoint',
    zillizToken: process.env.ZILLIZ_TOKEN || 'dummy_zilliz_token',
    customerProfileTableName: process.env.CUSTOMER_PROFILE_TABLE_NAME || 'CustomerProfile',
    customerVectorDBConfigTableName: process.env.CUSTOMER_VECTOR_DB_CONFIG_TABLE_NAME || 'CustomerVectorDBConfig',
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
    ingestNotesLambda: lambdaStack.ingestNotesLambda,
    auth0Domain: process.env.AUTH0_SPA_DOMAIN || 'dummy.auth0.com',
});
