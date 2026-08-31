from encoding_library.processors.conversation_processor import ConversationProcessor
from encoding_library.processors.data_processor import DataProcessor
from encoding_library.processors.email_processor import EmailProcessor
from encoding_library.processors.memory_processor import MemoryProcessor
from encoding_library.processors.note_processor import NoteProcessor
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.models.data_type import DataType


class ProcessorFactory:
    """
    Factory to get the appropriate DataProcessor based on MemoryRequestInternalState.
    """

    @staticmethod
    def get_processor(state: MemoryRequestInternalState) -> DataProcessor:
        """
        Return the correct processor for the given state's data_type.
        """
        data_type_str = state.data_type

        if data_type_str:
            try:
                data_type_enum = DataType(data_type_str.upper())

                if data_type_enum == DataType.EMAIL:
                    return EmailProcessor()
                elif data_type_enum == DataType.NOTE:
                    return NoteProcessor()
                elif data_type_enum == DataType.MEMORY:
                    return MemoryProcessor()
                elif data_type_enum == DataType.CONVERSATION:
                    return ConversationProcessor()

            except ValueError:
                pass

        raise ValueError(f"Unknown or missing data_type in state: '{data_type_str}'")
