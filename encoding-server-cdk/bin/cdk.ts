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
    createCollectionRepo: ecrStack.createCollectionRepo,
    storeEmbeddingsRepo: ecrStack.storeEmbeddingsRepo,
    storeS3Repo: ecrStack.storeS3Repo,
    ingestionImageTag: process.env.INGESTION_IMAGE_TAG,
    encodeImageTag: process.env.ENCODE_IMAGE_TAG,
    createCollectionImageTag: process.env.CREATE_COLLECTION_IMAGE_TAG,
    storeEmbeddingsImageTag: process.env.STORE_EMBEDDINGS_IMAGE_TAG,
    storeS3ImageTag: process.env.STORE_S3_IMAGE_TAG,
    zillizEndpoint: process.env.ZILLIZ_ENDPOINT!,
    zillizToken: process.env.ZILLIZ_TOKEN!,
    customerProfileTableName: process.env.CUSTOMER_PROFILE_TABLE_NAME || 'CustomerProfile',
});

if (!process.env.INGESTION_IMAGE_TAG || !process.env.ENCODE_IMAGE_TAG || !process.env.CREATE_COLLECTION_IMAGE_TAG || !process.env.STORE_EMBEDDINGS_IMAGE_TAG || !process.env.STORE_S3_IMAGE_TAG) {
    throw new Error('Image tags (INGESTION_IMAGE_TAG, ENCODE_IMAGE_TAG, CREATE_COLLECTION_IMAGE_TAG, STORE_EMBEDDINGS_IMAGE_TAG, STORE_S3_IMAGE_TAG) are required');
}

if (!process.env.ZILLIZ_ENDPOINT || !process.env.ZILLIZ_TOKEN) {
    throw new Error('Zilliz configuration (ZILLIZ_ENDPOINT, ZILLIZ_TOKEN) is required');
}

const stepFunctionsStack = new StepFunctionsStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-StepFunctionsStack`, {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    storeS3Repo: ecrStack.storeS3Repo,
    encodeLambda: lambdaStack.encodeLambda,
    createCollectionLambda: lambdaStack.createCollectionLambda,
    storeEmbeddingsLambda: lambdaStack.storeEmbeddingsLambda,
    storeS3Lambda: lambdaStack.storeS3Lambda,
});

if (!process.env.AUTH0_SPA_DOMAIN) {
    throw new Error('AUTH0_SPA_DOMAIN environment variable is required');
}

const apiGatewayStack = new ApiGatewayStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-ApiGatewayStack`, {
    stage,
    ingestionLambda: lambdaStack.ingestionLambda,
    auth0Domain: process.env.AUTH0_SPA_DOMAIN,
});
