from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Optional

@dataclass
class Payload:
    """
    Standardized payload structure for passing data between lambdas.
    """
    customer_id: str
    data: Dict[str, Any]
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'Payload':
        """Create Payload from dictionary."""
        return Payload(
            customer_id=data.get('customer_id'),
            data=data.get('data'),
            metadata=data.get('metadata')
        )
