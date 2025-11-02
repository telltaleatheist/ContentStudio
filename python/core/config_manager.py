#!/usr/bin/env python3
"""
Configuration Manager for LaunchPad
Manages AI provider settings and processing configuration
"""

from typing import Optional, Dict, Any
from pathlib import Path
import os


class ConfigManager:
    """Manages configuration for metadata generation"""

    def __init__(self,
                 ai_provider: str = 'ollama',
                 ai_model: Optional[str] = None,
                 ai_api_key: Optional[str] = None,
                 ai_host: str = 'http://localhost:11434',
                 platform: str = 'youtube',
                 prompt_set: str = 'youtube-telltale',
                 output_dir: Optional[str] = None):

        self.ai_provider = ai_provider
        self.ai_model = ai_model or 'cogito:70b'  # Default Ollama model
        self.ai_api_key = ai_api_key
        self.ai_host = ai_host
        self.platform = platform
        self.prompt_set = prompt_set

        # Set output directory
        if output_dir:
            self.output_dir = Path(output_dir)
        else:
            self.output_dir = Path.home() / 'Documents' / 'LaunchPad Output'

        # Create output directory if it doesn't exist
        self.output_dir.mkdir(parents=True, exist_ok=True)

    @property
    def ollama_base_url(self) -> str:
        """Get Ollama base URL"""
        return self.ai_host

    @property
    def fast_model(self) -> str:
        """Get fast model for summarization"""
        if self.ai_provider == 'ollama':
            # Use a faster Ollama model for summarization
            return 'llama3.1:8b'
        elif self.ai_provider == 'openai':
            # Use gpt-4o-mini for faster/cheaper summarization, or gpt-3.5-turbo as fallback
            return 'gpt-4o-mini'
        elif self.ai_provider == 'claude':
            return 'claude-3-5-haiku-20241022'
        return self.ai_model

    @property
    def smart_model(self) -> str:
        """Get smart model for metadata generation"""
        if self.ai_provider == 'ollama':
            return self.ai_model
        elif self.ai_provider == 'openai':
            # Use the specified model or default to gpt-4o
            return self.ai_model if self.ai_model else 'gpt-4o'
        elif self.ai_provider == 'claude':
            # Map user-friendly model names to API model identifiers
            # Parse the model name from self.ai_model if it was set
            if self.ai_model:
                # Handle Claude 3.5 models
                if 'claude-3-5-sonnet' in self.ai_model:
                    return 'claude-3-5-sonnet-20241022'
                elif 'claude-3-5-haiku' in self.ai_model:
                    return 'claude-3-5-haiku-20241022'
                # Handle legacy Claude 3 models
                elif 'claude-3-opus' in self.ai_model:
                    return 'claude-3-opus-20240229'
                elif 'claude-3-sonnet' in self.ai_model:
                    return 'claude-3-sonnet-20240229'
                elif 'claude-3-haiku' in self.ai_model:
                    return 'claude-3-haiku-20240307'
            # Default to Claude 3.5 Sonnet for best balance of quality and cost
            return 'claude-3-5-sonnet-20241022'
        return self.ai_model

    def get_ai_config(self) -> Dict[str, Any]:
        """Get AI configuration as dictionary"""
        return {
            'provider': self.ai_provider,
            'model': self.ai_model,
            'api_key': self.ai_api_key,
            'host': self.ai_host,
            'fast_model': self.fast_model,
            'smart_model': self.smart_model
        }
