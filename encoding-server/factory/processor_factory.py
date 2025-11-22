from typing import Dict, Any
from processors.data_processor import DataProcessor
from processors.email_processor import EmailProcessor

class ProcessorFactory:
    """
    Factory to get the appropriate DataProcessor.
    """

    @staticmethod
    def get_processor(data: Dict[str, Any]) -> DataProcessor:
        """
        Determine the type of data and return the corresponding processor.
        """
        # Heuristic for Email
        if 'message_id' in data and 'subject' in data:
            return EmailProcessor()
        
        # Future: Add other types here
        
        # Default or Error
        raise ValueError("Unknown data type. Could not determine processor.")
