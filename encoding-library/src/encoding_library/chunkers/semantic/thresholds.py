from abc import ABC, abstractmethod
from typing import List
import numpy as np

class ThresholdStrategy(ABC):
    """
    Strategy interface for determining cut points based on semantic distances.
    """
    @abstractmethod
    def calculate_breakpoints(self, distances: List[float]) -> List[int]:
        """
        Calculate indices where a chunk should end based on distances between sentences.
        """
        pass

class PercentileThreshold(ThresholdStrategy):
    """
    Establish breakpoints where distance > Xth percentile.
    """
    def __init__(self, percentile: int = 95):
        self.percentile = percentile

    def calculate_breakpoints(self, distances: List[float]) -> List[int]:
        if not distances:
            return []
            
        threshold = np.percentile(distances, self.percentile)
        
        # Breakpoints are indices where distance exceeds threshold
        breakpoints = [i for i, d in enumerate(distances) if d > threshold]
        return breakpoints

class StandardDeviationThreshold(ThresholdStrategy):
    """
    Establish breakpoints where distance > Mean + (multiplier * StdDev).
    """
    def __init__(self, std_dev_multiplier: float = 1.5):
        self.std_dev_multiplier = std_dev_multiplier

    def calculate_breakpoints(self, distances: List[float]) -> List[int]:
        if not distances:
            return []
            
        mean_dist = np.mean(distances)
        std_dist = np.std(distances)
        threshold = mean_dist + (self.std_dev_multiplier * std_dist)
        
        breakpoints = [i for i, d in enumerate(distances) if d > threshold]
        return breakpoints
