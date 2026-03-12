from typing import Dict, Any
from encoding_library.processors.data_processor import DataProcessor
from encoding_library.processors.email_processor import EmailProcessor
from encoding_library.processors.note_processor import NoteProcessor
from encoding_library.models.data_type import DataType

class ProcessorFactory:
    """
    Factory to get the appropriate DataProcessor.
    """

    @staticmethod
    def get_processor(data: Dict[str, Any]) -> DataProcessor:
        """
        Determine the type of data and return the corresponding processor.
        """
        data_type_str = data.get('dataType') or data.get('data_type')
        
        if data_type_str:
            try:
                data_type_enum = DataType(data_type_str.upper())
                
                if data_type_enum == DataType.EMAIL:
                    return EmailProcessor()
                elif data_type_enum == DataType.NOTE:
                    return NoteProcessor()
                    
            except ValueError:
                # If invalid enum, log or fallback below
                pass
        
        # Default or Error
        raise ValueError(f"Unknown data type or missing dataType field in payload: {list(data.keys())}")
