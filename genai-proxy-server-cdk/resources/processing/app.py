import json
import boto3
import os

s3 = boto3.client('s3')
BUCKET_NAME = os.environ['BUCKET_NAME']

def handler(event, context):
    print("Received event:", json.dumps(event))
    
    for record in event['Records']:
        payload = record['body']
        print(f"Processing payload: {payload}")
        
        # Simulate processing and S3 upload
        # s3.put_object(Bucket=BUCKET_NAME, Key='processed/key', Body=payload)
        
    return {
        'statusCode': 200,
        'body': json.dumps({'message': 'Processed'})
    }
