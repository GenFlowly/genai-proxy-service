import * as cdk from "aws-cdk-lib";
import { STAGES } from "@genflowly/cdk-commons";
import { Construct } from "constructs";
import { CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { IRepository, Repository } from "aws-cdk-lib/aws-ecr";
import { RESOURCE_NAMES } from "./constants";

export interface EcrStackProps extends cdk.StackProps {
    stage: STAGES;
}

export class EcrStack extends cdk.Stack {

    public readonly ingestionRepo: IRepository;
    public readonly parseAndChunkRepo: IRepository;

    constructor(scope: Construct, id: string, props: EcrStackProps) {
        super(scope, id, props);

        // Use DESTROY for development, RETAIN for production
        const removalPolicy = props.stage === STAGES.BETA ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

        // Ingestion Lambda Repository
        this.ingestionRepo = new Repository(this, 'IngestionLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-ingestion-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Parse and Chunk Lambda Repository
        this.parseAndChunkRepo = new Repository(this, 'ParseAndChunkLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-parse-and-chunk-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Outputs
        new CfnOutput(this, 'IngestionRepoUri', {
            value: this.ingestionRepo.repositoryUri,
        });

        new CfnOutput(this, 'ParseAndChunkRepoUri', {
            value: this.parseAndChunkRepo.repositoryUri,
        });

    }
}
