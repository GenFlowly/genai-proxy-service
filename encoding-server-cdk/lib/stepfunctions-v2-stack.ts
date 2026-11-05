import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { STAGES } from '@genflowly/cdk-commons';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { RESOURCE_NAMES } from "./constants";

export interface StepFunctionsV2StackProps extends cdk.StackProps {
    stage: STAGES;
    ingestionQueue: sqs.IQueue;
    // Failed executions quarantine their ORIGINAL message here (see below) —
    // this is the same DLQ the ingestion queue's redrive policy points at, so
    // one queue holds every kind of dead letter and redrive replays them all.
    deadLetterQueue: sqs.IQueue;
    parseAndChunkRepo: ecr.IRepository;
    parseAndChunkLambda: lambda.IFunction;
    createAndStoreLambda: lambda.IFunction;
    // Comma-separated emails subscribed to the pipeline-alerts SNS topic.
    alertEmails?: string;
}

export class StepFunctionsV2Stack extends cdk.Stack {

    public readonly processingStateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: StepFunctionsV2StackProps) {
        super(scope, id, props);

        // Define Step Functions Tasks
        const parseAndChunkTask = new tasks.LambdaInvoke(this, 'Parse and Chunk Text', {
            stateName:'Parse and Chunk Text',
            lambdaFunction: props.parseAndChunkLambda,
            payloadResponseOnly: true, // Return only the payload sequentially
        });

        // One step embeds AND stores: vectors never cross a state boundary, so
        // the 256KB state-payload cap (States.DataLimitExceeded on any batch of
        // ~10+ inline vectors — long messages could never embed) is structural
        // history, not a tuning concern.
        const createAndStoreTask = new tasks.LambdaInvoke(this, 'CreateAndStoreEmbeddings', {
            stateName:'CreateAndStoreEmbeddings',
            lambdaFunction: props.createAndStoreLambda,
            payloadResponseOnly: true,
        });

        const processBatchesMap = new sfn.Map(this, 'Process Batches Concurrently', {
            maxConcurrency: 3, // Bounds concurrent embed+insert calls per message
            itemsPath: sfn.JsonPath.stringAt('$.batches'),
            resultPath: sfn.JsonPath.DISCARD, // keep the state shape stable at the join
        });

        processBatchesMap.itemProcessor(createAndStoreTask);

        /**
         * Failure quarantine. The trigger lambda deletes the SQS message the
         * moment it starts an execution, so a failed execution used to vanish
         * silently — no redelivery, an empty DLQ, no alarm (hundreds of embeds
         * were lost unnoticed this way). On any failure, send the execution's
         * ORIGINAL input (the verbatim queue message, via the context object —
         * untouched by state transforms) to the DLQ, then still end in Fail so
         * ExecutionsFailed metrics/alarms stay truthful. Recovery is the SQS
         * redrive button: DLQ → ingestion queue → a fresh execution. A FAILED
         * execution has stored nothing (insert is the handler's last fallible
         * op), so replays cannot duplicate rows.
         */
        const sendFailedToDlq = new tasks.SqsSendMessage(this, 'Quarantine Original To DLQ', {
            stateName: 'Quarantine Original To DLQ',
            queue: props.deadLetterQueue,
            messageBody: sfn.TaskInput.fromText(
                sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$$.Execution.Input'))
            ),
            resultPath: sfn.JsonPath.DISCARD,
        });
        const embeddingFailed = new sfn.Fail(this, 'Embedding Failed', {
            error: 'EmbeddingPipelineFailed',
            cause: 'Original message quarantined to the DLQ; redrive it after fixing the cause.',
        });
        const quarantine = sendFailedToDlq.next(embeddingFailed);
        parseAndChunkTask.addCatch(quarantine, {
            errors: ['States.ALL'],
            resultPath: sfn.JsonPath.DISCARD,
        });
        processBatchesMap.addCatch(quarantine, {
            errors: ['States.ALL'],
            resultPath: sfn.JsonPath.DISCARD,
        });

        // Define Master Sequence Chain. This pipeline is realtime-only: Voyage
        // batch embedding is customer-level (embeddingMode=batch preference) and
        // runs entirely through the scheduled notes accumulator + poller in
        // LambdaStack — never through per-request executions here.
        const definition = parseAndChunkTask.next(processBatchesMap);

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
            // Executions carry ids, never text (encoding-server
            // services/content_source.py). Production logs failures only,
            // without execution data; development keeps the full trace.
            logs: {
                destination: logGroup,
                level: props.stage === STAGES.PROD ? sfn.LogLevel.ERROR : sfn.LogLevel.ALL,
                includeExecutionData: props.stage !== STAGES.PROD,
            },
        });

        /**
         * Alerting: a failed embed must page someone, not hide in console
         * history. Two alarms on one topic — executions failing, and anything
         * sitting in the DLQ (covers the quarantine path AND classic
         * trigger-delivery dead letters).
         */
        const alertsTopic = new sns.Topic(this, `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-pipeline-alerts`, {
            topicName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-pipeline-alerts`,
        });
        (props.alertEmails || '')
            .split(',')
            .map((email) => email.trim())
            .filter((email) => email.length > 0)
            .forEach((email) => alertsTopic.addSubscription(new subscriptions.EmailSubscription(email)));

        const executionsFailedAlarm = new cloudwatch.Alarm(this, 'PipelineExecutionsFailedAlarm', {
            alarmName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-pipeline-executions-failed`,
            alarmDescription: 'Encoding pipeline executions are failing; originals are quarantined in the DLQ.',
            metric: this.processingStateMachine.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        executionsFailedAlarm.addAlarmAction(new cwactions.SnsAction(alertsTopic));

        const dlqNotEmptyAlarm = new cloudwatch.Alarm(this, 'PipelineDlqNotEmptyAlarm', {
            alarmName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-dlq-not-empty`,
            alarmDescription: 'Encoding DLQ has messages; redrive them to the ingestion queue after fixing the cause.',
            metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        dlqNotEmptyAlarm.addAlarmAction(new cwactions.SnsAction(alertsTopic));

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
                // Log level + content gating — see genai-proxy-server/development.md
                APP_ENV: props.stage === STAGES.PROD ? 'production' : 'development',
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
