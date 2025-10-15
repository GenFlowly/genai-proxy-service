#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { STAGES } from '@genflowly/cdk-commons';
import { EcsStack } from "../lib/ecs-stack";
import {EcrStack} from "../lib/ecr-stack";
import {OneTimeDeploymentPerStageStack} from "../lib/oneTimeDeploymentPerStage-stack";

const serviceName: string = 'gen-ai-proxy-service';
const stage: STAGES = STAGES.BETA;

const app = new cdk.App();

new OneTimeDeploymentPerStageStack(app, 'BootstrapStack', {stage})

const dynamoDBStack = new DynamoDBStack(app, 'DynamoDBStack', {});
const ecrStack = new EcrStack(app, 'EcrStack', { serviceName, stage });
new EcsStack(app, 'EcsStack', { serviceName, stage, ecrRepo: ecrStack.repository, userTable: dynamoDBStack.userTable });
