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

export interface StepFunctionsStackProps extends cdk.StackProps {
    stage: STAGES;
    ingestionQueue: sqs.IQueue;
    storeS3Repo: ecr.IRepository;
    updateDynamoDbRepo: ecr.IRepository;
    encodeLambda: lambda.IFunction;
    storeEmbeddingsLambda: lambda.IFunction;
    storeS3Lambda: lambda.IFunction;
    updateDynamoDbLambda: lambda.IFunction;
}

export class StepFunctionsStack extends cdk.Stack {

    public readonly processingStateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: StepFunctionsStackProps) {
        super(scope, id, props);

        // Define Step Functions Tasks
        const encodeTask = new tasks.LambdaInvoke(this, 'Chunk and Encode' +
            ' Text', {
            lambdaFunction: props.encodeLambda,
            payloadResponseOnly: true, // Return only the payload
        });

        const storeEmbeddingsTask = new tasks.LambdaInvoke(this, 'Store Embeddings', {
            lambdaFunction: props.storeEmbeddingsLambda,
            payloadResponseOnly: true,
        });

        const updateDynamoDbTask = new tasks.LambdaInvoke(this, 'UpdateDynamoDB Lambda', {
            lambdaFunction: props.updateDynamoDbLambda,
            payloadResponseOnly: true,
        });

        // Define Chain: Encode -> Create Collection -> Store Embeddings -> Update DynamoDB
        const definition = encodeTask
            .next(storeEmbeddingsTask)
            .next(updateDynamoDbTask);

        // Define State Machine (Express Workflow for high throughput/low latency)
        const logGroup = new cdk.aws_logs.LogGroup(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-sm-logs`, {
            retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.processingStateMachine = new sfn.StateMachine(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-processing-sm`, {
            stateMachineName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-state-machine-standard`,
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
         * Trigger Lambda - Reads from SQS and starts Step Function
         * Uses the same Docker image as the worker lambdas
         */

        const triggerLambda = new DockerImageFunction(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-trigger-lambda`, {
            functionName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-trigger-lambda`,
            code: DockerImageCode.fromEcr(props.updateDynamoDbRepo, {
                tagOrDigest: 'update-dynamodb-latest',
                cmd: ['handlers.trigger_lambda.handler'],
            }),
            memorySize: 256,
            timeout: cdk.Duration.seconds(900), // Maxed out as requested
            architecture: lambda.Architecture.X86_64,
            environment: {
                STATE_MACHINE_ARN: this.processingStateMachine.stateMachineArn,
            },
        });

        // Grant permissions
        this.processingStateMachine.grantStartExecution(triggerLambda);
        props.ingestionQueue.grantConsumeMessages(triggerLambda);

        // Add SQS Trigger
        triggerLambda.addEventSource(new SqsEventSource(props.ingestionQueue, {
            reportBatchItemFailures: true,
            batchSize: 10, // Adjust as needed
        }));
    }
}
