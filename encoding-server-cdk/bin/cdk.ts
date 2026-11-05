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

import { StepFunctionsV2Stack } from "../lib/stepfunctions-v2-stack";

const stageEnv = process.env.STAGE;
const stage: STAGES = stageEnv === 'production' ? STAGES.PROD : STAGES.BETA;

const app = new cdk.App();

const ecrStack = new EcrStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-EcrStack`, { stage });
const s3Stack = new S3Stack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-S3Stack`, { stage });
const sqsStack = new SqsStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-SqsStack`, { stage });
const lambdaStack = new LambdaStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-LambdaStack`, {
    stage,
    ingestionQueue: sqsStack.ingestionQueue,
    rawEmailBucket: s3Stack.rawEmailBucket,
    customerDocumentsBucket: s3Stack.customerDocumentsBucket,
    ingestionRepo: ecrStack.ingestionRepo,
    parseAndChunkRepo: ecrStack.parseAndChunkRepo,
    storeEmbeddingsRepo: ecrStack.storeEmbeddingsRepo,
    createAndStoreRepo: ecrStack.createAndStoreRepo,
    createCollectionsRepo: ecrStack.createCollectionsRepo,
    ingestionImageTag: process.env.INGESTION_IMAGE_TAG || 'latest',
    parseAndChunkImageTag: process.env.PARSE_AND_CHUNK_IMAGE_TAG || 'latest',
    storeEmbeddingsImageTag: process.env.STORE_EMBEDDINGS_IMAGE_TAG || 'latest',
    createAndStoreImageTag: process.env.CREATE_AND_STORE_IMAGE_TAG || 'latest',
    createCollectionsImageTag: process.env.CREATE_COLLECTIONS_IMAGE_TAG || 'latest',
    customerProfileTableName: process.env.CUSTOMER_PROFILE_TABLE_NAME || 'CustomerProfile',
    customerVectorDBConfigTableName: process.env.CUSTOMER_VECTOR_DB_CONFIG_TABLE_NAME || 'CustomerVectorDBConfig',
    customerNotesTableName: process.env.CUSTOMER_NOTES_TABLE_NAME || 'CustomerNotes',
    instructionsTableName: process.env.INSTRUCTIONS_TABLE_NAME || 'Instructions',
    messageTableName: process.env.MESSAGE_TABLE_NAME || 'Message',
    conversationTableName: process.env.CONVERSATION_TABLE_NAME || 'Conversation',
    customerMemoryTableName: process.env.CUSTOMER_MEMORY_TABLE_NAME || 'CustomerMemory',
    vectorSyncPendingTableName: process.env.VECTOR_SYNC_PENDING_TABLE_NAME || 'VectorSyncPending',
    customerApiKeyTableName: process.env.CUSTOMER_API_KEY_TABLE_NAME || 'CustomerVendorApiKeys',
    purgeAllowedClientIds: process.env.PURGE_ALLOWED_CLIENT_IDS,
    customerApiUsageTableName: process.env.CUSTOMER_API_USAGE_TABLE_NAME || 'CustomerAIUsage',
    aiModelCatalogTableName: process.env.AI_MODEL_CATALOG_TABLE_NAME || 'AIModelCatalog',
});

const stepFunctionsV2Stack = new StepFunctionsV2Stack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-StepFunctionsV2Stack`, {
    stage: stage,
    ingestionQueue: sqsStack.ingestionQueue,
    deadLetterQueue: sqsStack.deadLetterQueue,
    parseAndChunkRepo: ecrStack.parseAndChunkRepo,
    parseAndChunkLambda: lambdaStack.parseAndChunkLambda,
    createAndStoreLambda: lambdaStack.createAndStoreLambda,
    alertEmails: process.env.ADMIN_EMAILS,
});



const apiGatewayStack = new ApiGatewayStack(app, `${RESOURCE_NAMES.ENCODING_SERVICE}-ApiGatewayStack`, {
    stage,
    ingestEmailLambda: lambdaStack.ingestEmailLambda,
    ingestNotesLambda: lambdaStack.ingestNotesLambda,
    createCollectionsLambda: lambdaStack.createCollectionsLambda,
    purgeVectorsLambda: lambdaStack.purgeVectorsLambda,
    auth0Domain: process.env.AUTH0_SPA_DOMAIN || 'dummy.auth0.com',
});
