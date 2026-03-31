import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { RESOURCE_NAMES } from "./constants";

export interface StepFunctionsV2StackProps extends cdk.StackProps {
    stage: STAGES;
    ingestionQueue: sqs.IQueue;
    parseAndChunkRepo: ecr.IRepository;
    parseAndChunkLambda: lambda.IFunction;
}

export class StepFunctionsV2Stack extends cdk.Stack {

    public readonly processingStateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: StepFunctionsV2StackProps) {
        super(scope, id, props);

        // Define Step Functions Tasks
        const parseAndChunkTask = new tasks.LambdaInvoke(this, 'Parse and Chunk Text', {
            lambdaFunction: props.parseAndChunkLambda,
            payloadResponseOnly: true, // Return only the payload sequentially
        });

        // Define Chain: ParseAndChunk (Only for now as orchestrated)
        const definition = parseAndChunkTask;

        // Define State Machine (Standard Workflow for extended timeout limits)
        const logGroup = new cdk.aws_logs.LogGroup(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-sm-v2-logs`, {
            retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.processingStateMachine = new sfn.StateMachine(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-processing-sm-v2`, {
            stateMachineName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-state-machine-v2`,
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            stateMachineType: sfn.StateMachineType.STANDARD,
            timeout: cdk.Duration.hours(2),
            logs: {
                destination: logGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        /**
         * Trigger Lambda V2 - Reads from SQS and starts Step Function V2
         * Operates entirely siloed from the V1 stack
         */
        const triggerLambdaV2 = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-trigger-lambda-v2`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-trigger-lambda-v2`,
            code: DockerImageCode.fromEcr(props.parseAndChunkRepo, {
                tagOrDigest: 'parse-and-chunk-latest',
                cmd: ['handlers.trigger_lambda.handler'],
            }),
            memorySize: 256,
            timeout: cdk.Duration.seconds(900),
            architecture: lambda.Architecture.X86_64,
            environment: {
                STATE_MACHINE_ARN: this.processingStateMachine.stateMachineArn,
            },
        });

        // Grant core permissions
        this.processingStateMachine.grantStartExecution(triggerLambdaV2);
        props.ingestionQueue.grantConsumeMessages(triggerLambdaV2);

        // Note: Adding this trigger event source connects the existing SQS queue natively to this new handler
        triggerLambdaV2.addEventSource(new SqsEventSource(props.ingestionQueue, {
            reportBatchItemFailures: true,
            batchSize: 10,
        }));
    }
}
