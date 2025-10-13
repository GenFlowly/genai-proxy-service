import * as cdk from "aws-cdk-lib";
import {STAGES} from "@genflowly/cdk-commons";
import {Construct} from "constructs";
import {EcsStackProps} from "./ecs-stack";
import {CfnOutput, RemovalPolicy} from "aws-cdk-lib";
import {IRepository, Repository} from "aws-cdk-lib/aws-ecr";


export interface EcrStackProps extends cdk.StackProps {
    serviceName: string;
    stage: STAGES;
}


export class EcrStack extends cdk.Stack {

    public readonly repository: IRepository;
    constructor(scope: Construct, id: string, props: EcrStackProps) {
        super(scope, id, props);

        const repoName = `${props.serviceName}-${props.stage}-repo`;

        let importedRepo: IRepository | undefined;
        try {
            importedRepo = Repository.fromRepositoryName(this, `${repoName}-id`, repoName);
        } catch (err) {
            importedRepo = undefined;
        }

        const newRepo = new Repository(this, `${repoName}-id`, {
            repositoryName: repoName,
            imageScanOnPush: true,
            lifecycleRules: [
                { maxImageCount: 5, description: 'Keep last 5 images only' },
            ],
            removalPolicy: RemovalPolicy.RETAIN,  // don't auto-delete on stack destroy
        });

        this.repository = importedRepo ?? newRepo;

        new CfnOutput(this, 'EcrRepositoryUri', {
            value: this.repository.repositoryUri,
        });

    }
}
