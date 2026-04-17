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

    const domainName = props.stage === STAGES.PROD
        ?  `api.genflowly.com`
        :  `api-${props.stage}.genflowly.com`;

    console.log(`⏳ NOTE: Certificate creation for ${domainName} requires DNS validation.`);
    console.log(`   1. Go to AWS Certificate Manager → Certificates`);
    console.log(`   2. Find the pending certificate for ${domainName}`);
    console.log(`   3. Copy the CNAME name and value shown under "Domains"`);
    console.log(`   4. Add that CNAME record to your DNS provider for genflowly.com`);
    console.log(`   5. ACM will validate automatically within a few minutes and the stack will complete.\n`);

    const certificate = new cdk.aws_certificatemanager.Certificate(this, 'ApiCertificate', {
      domainName: domainName,
      validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      exportName: `GenAIProxy-CertificateArn-${props.stage}`,
    });
  }

}