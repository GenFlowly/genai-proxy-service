#!/bin/bash
# Usage: ./get_acm_cname.sh <stage>
# Example: ./get_acm_cname.sh beta

STAGE="development"

if [ -z "$STAGE" ]; then
  echo "Usage: $0 <stage>"
  echo "Example: $0 beta"
  exit 1
fi

DOMAIN="api-${STAGE}.genflowly.com"

echo "Looking for PENDING_VALIDATION certificates for domain: $DOMAIN ..."

# Find Certificate ARN
CERT_ARN=$(aws acm list-certificates --certificate-statuses PENDING_VALIDATION --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn" --output text)

if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" == "None" ]; then
    echo "No pending certificates found for $DOMAIN. Checking ISSUED certificates..."
    CERT_ARN=$(aws acm list-certificates --certificate-statuses ISSUED --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn" --output text)
fi

if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" == "None" ]; then
    echo "Error: Could not find any certificate for $DOMAIN."
    exit 1
fi

echo "Found Certificate ARN: $CERT_ARN"

# Get Validation Details
echo ""
echo "Fetching DNS Validation Record..."

# Use jq if available for pretty printing, otherwise use text output
aws acm describe-certificate --certificate-arn "$CERT_ARN" --query "Certificate.DomainValidationOptions[0].ResourceRecord" --output json
