import json
import logging
from typing import Dict, Any, Tuple
from .data_processor import DataProcessor

# Assuming email_model is in the python path (root of lambda task)
try:
    from email_model import EmailModel
except ImportError:
    # Fallback for local development if needed, though usually root is in path
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from email_model import EmailModel

logger = logging.getLogger()

class EmailProcessor(DataProcessor):
    """
    Processor for Email data.
    """

    def validate(self, data: Dict[str, Any]) -> bool:
        """
        Validate that the data is a valid email.
        """
        required_fields = ['message_id', 'subject', 'body', 'from', 'to', 'date', 'folder']
        missing_fields = [field for field in required_fields if field not in data]
        
        if missing_fields:
            raise ValueError(f"Missing required fields: {missing_fields}")
        
        # Validate EmailModel can be created
        try:
            email_model = EmailModel.from_dict(data)
            logger.info(f"Validated EmailModel for message_id: {email_model.message_id}")
        except Exception as e:
            raise ValueError(f"Invalid EmailModel data: {str(e)}")
            
        return True

    def to_sqs_message(self, data: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        """
        Convert email data to SQS message format.
        """
        email_model = EmailModel.from_dict(data)
        email_dict = email_model.to_dict()
        
        message_body = json.dumps(email_dict)
        message_attributes = {
            'messageId': {
                'StringValue': email_model.message_id,
                'DataType': 'String'
            },
            'folder': {
                'StringValue': email_model.folder,
                'DataType': 'String'
            },
            'type': {
                'StringValue': 'email',
                'DataType': 'String'
        }
        
        return message_body, message_attributes

    def prepare_for_vector_db(self, data: Dict[str, Any], embedding: list) -> Dict[str, Any]:
        """
        Prepare email data for insertion into Zilliz/Milvus.
        """
        email_model = EmailModel.from_dict(data)
        
        return {
            "id": email_model.message_id,
            "vector": embedding,
            "subject": email_model.subject[:500],  # Limit field size
            "from_email": email_model.from_addr[:200],
            "to_email": ", ".join(email_model.to_addrs)[:200],  # Join list to string
            "date": email_model.date.isoformat() if email_model.date else "",
            "folder": email_model.folder[:100],
            "thread_id": (email_model.thread_id or "")[:200],
            "in_reply_to": (email_model.in_reply_to or "")[:200],
            "s3_key": f"emails/{email_model.folder}/{email_model.message_id}.json"
        }
