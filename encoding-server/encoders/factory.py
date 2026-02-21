from typing import Union
from .encoder import Encoder
from .sentence_transformer_encoder import SentenceTransformerEncoder
from .enums import ModelType, ModelName

class EncoderFactory:
    """
    Factory class to get the appropriate encoder.
    """
    
    @staticmethod
    def get_encoder(model_type: Union[str, ModelType] = ModelType.SENTENCE_TRANSFORMER, 
                    model_name: Union[str, ModelName] = ModelName.ALL_MINILM_L6_V2, 
                    **kwargs) -> Encoder:
        """
        Get encoder based on model type and name.
        Default is SentenceTransformer with all-MiniLM-L6-v2.
        """
        # Normalize input to Enum
        if isinstance(model_type, str):
            try:
                model_type = ModelType(model_type)
            except ValueError:
                raise ValueError(f"Unknown model type: {model_type}")

        if model_type == ModelType.SENTENCE_TRANSFORMER:
            device = kwargs.get('device', 'cpu')
            # Handle ModelName enum or string for model_name
            if isinstance(model_name, ModelName):
                name_str = model_name.value
            else:
                name_str = model_name
                
            return SentenceTransformerEncoder(model_name=name_str, device=device)
        
        # Add other model types here if needed (e.g. OpenAI, Cohere)
        
        raise ValueError(f"Unknown model type: {model_type}")
