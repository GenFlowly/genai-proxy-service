from typing import Dict, Any
from encoding_library.processors.data_processor import DataProcessor
from encoding_library.processors.email_processor import EmailProcessor
from encoding_library.processors.note_processor import NoteProcessor

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

        # Heuristic for Note
        if 'note_value' in data:
            return NoteProcessor()
        
        # Future: Add other types here
        
        # Default or Error
        raise ValueError("Unknown data type. Could not determine processor.")
