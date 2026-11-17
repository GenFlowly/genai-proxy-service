import * as cdk from "aws-cdk-lib";
import { STAGES } from "@genflowly/cdk-commons";
import { Construct } from "constructs";
import { CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { IRepository, Repository } from "aws-cdk-lib/aws-ecr";
import { ArnPrincipal } from "aws-cdk-lib/aws-iam";
import { RESOURCE_NAMES } from "./constants";

export interface EcrStackProps extends cdk.StackProps {
    stage: STAGES;
    /**
     * IAM user or role the deploy pipeline pushes images as, granted pull and
     * push on every repository here. Docker 29 (containerd image store) checks
     * the manifest with a HEAD before pushing it, which needs ecr:BatchGetImage.
     */
    deployPrincipalArn?: string;
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
            lifecycleRules: [{ maxImageCount: 1 }],
        });

        // Parse and Chunk Lambda Repository
        this.parseAndChunkRepo = new Repository(this, 'ParseAndChunkLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-parse-and-chunk-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 1 }],
        });

        // Store Embeddings Lambda Repository
        this.storeEmbeddingsRepo = new Repository(this, 'StoreEmbeddingsLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-store-embeddings-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 1 }],
        });

        // Create-and-Store Lambda Repository (merged embed+store step)
        this.createAndStoreRepo = new Repository(this, 'CreateAndStoreLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-and-store-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 1 }],
        });

        // Create Collections Lambda Repository
        this.createCollectionsRepo = new Repository(this, 'CreateCollectionsLambdaRepo', {
            repositoryName: `${RESOURCE_NAMES.ENCODING_SERVICE}-${props.stage}-create-collections-repo`,
            removalPolicy: removalPolicy,
            lifecycleRules: [{ maxImageCount: 1 }],
        });

        if (props.deployPrincipalArn) {
            const deployer = new ArnPrincipal(props.deployPrincipalArn);
            for (const repo of [
                this.ingestionRepo,
                this.parseAndChunkRepo,
                this.storeEmbeddingsRepo,
                this.createAndStoreRepo,
                this.createCollectionsRepo,
            ]) {
                repo.grantPullPush(deployer);
            }
        }

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

