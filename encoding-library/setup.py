from setuptools import setup, find_packages

setup(
    name="genflowly-encoding-library",
    version="0.1.0",
    description="A library for text chunking and embedding operations.",
    author="Genflowly",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    install_requires=[
        "pymilvus",
        "sentence-transformers>=2.2.0",
        "scikit-learn",
        "scipy",
        "numpy"
    ],
    python_requires=">=3.9",
)
