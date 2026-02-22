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
    public readonly encodeRepo: IRepository;
    public readonly createCollectionRepo: IRepository;
    public readonly storeEmbeddingsRepo: IRepository;
    public readonly storeS3Repo: IRepository;

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

        // Encode Lambda Repository
        this.encodeRepo = new Repository(this, 'EncodeLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-encode-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Create Collection Lambda Repository
        this.createCollectionRepo = new Repository(this, 'CreateCollectionLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collection-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Store Embeddings Lambda Repository
        this.storeEmbeddingsRepo = new Repository(this, 'StoreEmbeddingsLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Store S3 Lambda Repository (shared with trigger)
        this.storeS3Repo = new Repository(this, 'StoreS3LambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-s3-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Outputs
        new CfnOutput(this, 'IngestionRepoUri', {
            value: this.ingestionRepo.repositoryUri,
        });

        new CfnOutput(this, 'EncodeRepoUri', {
            value: this.encodeRepo.repositoryUri,
        });

        new CfnOutput(this, 'CreateCollectionRepoUri', {
            value: this.createCollectionRepo.repositoryUri,
        });

        new CfnOutput(this, 'StoreEmbeddingsRepoUri', {
            value: this.storeEmbeddingsRepo.repositoryUri,
        });

        new CfnOutput(this, 'StoreS3RepoUri', {
            value: this.storeS3Repo.repositoryUri,
        });

    }
}
