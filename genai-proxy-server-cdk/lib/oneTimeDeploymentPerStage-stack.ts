import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from "constructs";
import { setupGitHubActionsForCDKDeployment, STAGES } from "@genflowly/cdk-commons";
import { CDK_DEPLOY_ROLE_NAME } from "./constants";

export interface IamStackProps extends cdk.StackProps {
  stage: STAGES;
}

export class OneTimeDeploymentPerStageStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    const ghAccessKey = setupGitHubActionsForCDKDeployment(props.stage, this)

    new cdk.CfnOutput(this, 'AWS_ACCESS_KEY_ID', {
      value: ghAccessKey.ref,
    });

    new cdk.CfnOutput(this, 'AWS_SECRET_ACCESS_KEY', {
      value: ghAccessKey.attrSecretAccessKey,
    });

    new iam.CfnRolePolicy(this, 'CdkDeployRolePermissions', {
      roleName: CDK_DEPLOY_ROLE_NAME(this.account, this.region),
      policyName: 'CdkDeployRolePermissions',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['cloudformation:DescribeEvents'],
          Resource: '*',
        }]
      }
    });

    console.log("\n📋 BootstrapStack.AWS_ACCESS_KEY_ID and BootstrapStack.AWS_SECRET_ACCESS_KEY outputs above");
    console.log("   → Update these values in GitHub Actions: repository Settings > Secrets and variables > Actions\n");
  }

}