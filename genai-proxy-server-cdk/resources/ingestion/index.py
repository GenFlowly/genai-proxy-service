import json
import boto3
import os

sqs = boto3.client('sqs')
QUEUE_URL = os.environ['QUEUE_URL']

def handler(event, context):
    print("Received event:", json.dumps(event))
    
    try:
        # Push to SQS
        sqs.send_message(
            QueueUrl=QUEUE_URL,
            MessageBody=json.dumps(event)
        )
        
        return {
            'statusCode': 202,
            'body': json.dumps({'message': 'Accepted'})
        }
    except Exception as e:
        print(e)
        return {
            'statusCode': 500,
            'body': json.dumps({'message': 'Internal Server Error'})
        }
