import os
import boto3
import json
import logging
from typing import Dict, Any, Tuple, Optional

logger = logging.getLogger()

class AuthorizationService:
    """
    Service to handle authorization checks and retrieve customer context.
    """
    
    def __init__(self):
        region = os.environ.get('AWS_REGION', 'us-east-1')
        self.dynamodb = boto3.resource('dynamodb', region_name=region)
        self.table_name = os.environ.get('CUSTOMER_PROFILE_TABLE_NAME', 'CustomerProfile')
        self.table = self.dynamodb.Table(self.table_name)

    def verify_user(self, event: Dict[str, Any]) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
        """
        Verify that the user exists in the DynamoDB table and retrieve their customerId.
        
        Args:
            event: The Lambda event object containing the request context.
            
        Returns:
            Tuple containing:
            - bool: True if authorized, False otherwise.
            - str: customerId if authorized, None otherwise.
            - dict: Error response dict if unauthorized, None if authorized.
        """
        try:
            # Extract 'sub' from the authorizer context
            # API Gateway HTTP API (v2) structure: event['requestContext']['authorizer']['jwt']['claims']['sub']
            claims = event.get('requestContext', {}).get('authorizer', {}).get('jwt', {}).get('claims', {})
            user_sub = claims.get('sub')
            
            if not user_sub:
                logger.error("No 'sub' claim found in JWT")
                return False, None, {
                    'statusCode': 401,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({'error': 'Unauthorized: Missing user identity'})
                }
                
            # Check if user exists in CustomerProfile table
            # Table has composite key (sub, client), so we must use query instead of get_item
            from boto3.dynamodb.conditions import Key
            response = self.table.query(
                KeyConditionExpression=Key('sub').eq(user_sub)
            )
            
            if not response.get('Items'):
                logger.warning(f"User {user_sub} not found in CustomerProfile table")
                return False, None, {
                    'statusCode': 403,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({'error': 'Forbidden: User profile not found'})
                }
            
            # Use the first item found (assuming sub is unique enough for identity, 
            # or we just take the first client profile associated with this sub)
            item = response['Items'][0]
            customer_id = item.get('customerId')
            
            if not customer_id:
                logger.error(f"User {user_sub} found but missing customerId")
                return False, None, {
                    'statusCode': 500,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({'error': 'Internal Server Error: Invalid user profile'})
                }
                
            logger.info(f"User {user_sub} authorized with customerId: {customer_id}")
            return True, customer_id, None
            
        except Exception as e:
            logger.error(f"Authorization check failed: {str(e)}")
            return False, None, {
                'statusCode': 500,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'Internal Server Error during authorization'})
            }
