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
    // storeEmbeddingsRepo stays: the Voyage batch lambdas ride its image.
    public readonly storeEmbeddingsRepo: IRepository;
    public readonly createAndStoreRepo: IRepository;
    public readonly createCollectionsRepo: IRepository;

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

        /**
         * Gone from the app, pinned here: the DEPLOYED (stage-1) LambdaStack
         * still imports this repo's Arn/name, and EcrStack deploys BEFORE
         * LambdaStack in the same run — dropping the auto-exports first fails
         * the update ("Cannot delete export ... in use by
         * encoding-service-LambdaStack", 2026-10-21). exportValue() re-creates
         * those exact exports so this stack can update while the old consumer
         * still exists; the same-run LambdaStack deploy then drops the
         * imports. Once that LambdaStack is live everywhere (prod AND dev), a
         * cleanup commit may remove this repo and both pins together.
         */
        const createEmbeddingsRepo = new Repository(this, 'CreateEmbeddingsLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-embeddings-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });
        this.exportValue(createEmbeddingsRepo.repositoryArn);
        this.exportValue(createEmbeddingsRepo.repositoryName);

        // Store Embeddings Lambda Repository
        this.storeEmbeddingsRepo = new Repository(this, 'StoreEmbeddingsLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Create-and-Store Lambda Repository (merged embed+store step)
        this.createAndStoreRepo = new Repository(this, 'CreateAndStoreLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-and-store-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 5 }],
        });

        // Create Collections Lambda Repository
        this.createCollectionsRepo = new Repository(this, 'CreateCollectionsLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collections-repo`,
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

        new CfnOutput(this, 'StoreEmbeddingsRepoUri', {
            value: this.storeEmbeddingsRepo.repositoryUri,
        });

        new CfnOutput(this, 'CreateAndStoreRepoUri', {
            value: this.createAndStoreRepo.repositoryUri,
        });

        new CfnOutput(this, 'CreateCollectionsRepoUri', {
            value: this.createCollectionsRepo.repositoryUri,
        });

    }
}

