#!/usr/bin/env python3
"""
core/ai_manager.py
AI Manager for LaunchPad - Multi-Provider Support
Handles AI metadata generation with Ollama, OpenAI, and Claude (Anthropic)

USAGE EXAMPLE:
    from core.config_manager import ConfigManager
    from core.ai_manager import AIManager

    # Configure with Ollama (default)
    config = ConfigManager(
        ai_provider='ollama',
        ai_model='cogito:70b',
        ai_host='http://localhost:11434',
        platform='youtube'
    )

    # Or configure with OpenAI
    config = ConfigManager(
        ai_provider='openai',
        ai_api_key='sk-...',
        platform='youtube'
    )

    # Or configure with Claude (Anthropic)
    config = ConfigManager(
        ai_provider='claude',
        ai_api_key='sk-ant-...',
        platform='youtube'
    )

    # Initialize AI Manager
    ai_manager = AIManager(config)
    if not ai_manager.initialize():
        print("Failed to initialize AI manager")
        exit(1)

    # Summarize long transcript
    transcript = "Very long transcript text..."
    summary = ai_manager.summarize_transcript(transcript, "video_name.mp4")

    # Generate metadata
    result = ai_manager.generate_metadata(summary, platform='youtube')

    if result.success:
        metadata = result.metadata
        print(f"Titles: {metadata['titles']}")
        print(f"Description: {metadata['description']}")
        print(f"Tags: {metadata['tags']}")
        print(f"Hashtags: {metadata['hashtags']}")
        print(f"Thumbnail text: {metadata['thumbnail_text']}")
        print(f"Processing time: {result.processing_time:.2f}s")
    else:
        print(f"Error: {result.error}")

    # Cleanup
    ai_manager.cleanup()

SUPPORTED PLATFORMS:
    - youtube: Generates YouTube-optimized metadata (titles, descriptions, tags, hashtags, thumbnail text)
    - spreaker: Generates podcast-optimized metadata for Spreaker platform

METADATA OUTPUT STRUCTURE:
    {
        "thumbnail_text": ["OPTION 1", "OPTION 2", ...],  # 10 options, ALL CAPS, max 3 words
        "titles": ["Title 1", "Title 2", ...],             # 10 titles, 45-70 characters
        "description": "Full description text...",          # Complete description
        "tags": "tag1, tag2, tag3, ...",                   # 15 comma-separated tags
        "hashtags": "#hashtag1 #hashtag2 ..."              # 10 hashtags with # symbols
    }
"""

import sys
import time
import json
import re
import requests
import tempfile
import yaml
from pathlib import Path
from typing import Optional, Dict, List, Tuple
from dataclasses import dataclass

# Import AI provider libraries (optional imports)
try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    print("Warning: openai library not installed. OpenAI provider will not be available.", file=sys.stderr)

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False
    print("Warning: anthropic library not installed. Claude provider will not be available.", file=sys.stderr)

from .config_manager import ConfigManager


@dataclass
class ConsolidatedResult:
    """Result from consolidated metadata generation"""
    metadata: Dict[str, any]
    success: bool
    processing_time: float
    fixes_applied: List[str]
    error: Optional[str] = None


class AIManager:
    """
    AI Manager for metadata generation with multi-provider support
    Supports: Ollama (default), OpenAI, and Claude (Anthropic)
    """

    def __init__(self, config: ConfigManager):
        self.config = config
        self.current_model = None
        self.model_ready = False

        # Set up provider-specific clients
        self.provider = config.ai_provider.lower()
        self.openai_client = None
        self.anthropic_client = None

        # Use smart model for metadata generation
        self.metadata_model = config.smart_model
        # Use fast model for summarization
        self.summary_model = config.fast_model

        # Temp directory for chunking
        self.temp_dir = Path(tempfile.gettempdir()) / "launchpad_temp"
        self.temp_dir.mkdir(exist_ok=True)

        # Platform-specific settings
        self.platform = config.platform.lower()

        # Load prompts from YAML files (exactly like ContentStudio)
        self.prompts_dir = Path(__file__).parent.parent / "prompts"
        self.youtube_prompts = None
        self.spreaker_prompts = None
        self.summarization_prompts = None
        self.description_links = None
        self._load_prompts()

    def initialize(self) -> bool:
        """Initialize AI manager and test connectivity"""
        print(f"Initializing AI Manager", file=sys.stderr)
        print(f"   Provider: {self.provider}", file=sys.stderr)
        print(f"   Summary Model: {self.summary_model}", file=sys.stderr)
        print(f"   Metadata Model: {self.metadata_model}", file=sys.stderr)
        print(f"   Platform: {self.platform}", file=sys.stderr)

        try:
            if self.provider == 'ollama':
                return self._initialize_ollama()
            elif self.provider == 'openai':
                return self._initialize_openai()
            elif self.provider == 'claude':
                return self._initialize_claude()
            else:
                print(f"Error: Unknown AI provider '{self.provider}'", file=sys.stderr)
                return False
        except Exception as e:
            print(f"Initialization error: {e}", file=sys.stderr)
            return False

    def _initialize_ollama(self) -> bool:
        """Initialize Ollama provider"""
        print(f"   Server: {self.config.ollama_base_url}", file=sys.stderr)

        try:
            response = requests.get(
                f"{self.config.ollama_base_url}/api/tags",
                timeout=10
            )
            if response.status_code == 200:
                print(f"Ollama server connected", file=sys.stderr)
                return True
            else:
                print(f"Ollama server error: HTTP {response.status_code}", file=sys.stderr)
                return False
        except Exception as e:
            print(f"Cannot connect to Ollama: {e}", file=sys.stderr)
            return False

    def _initialize_openai(self) -> bool:
        """Initialize OpenAI provider"""
        if not OPENAI_AVAILABLE:
            print(f"Error: openai library not installed. Install with: pip install openai", file=sys.stderr)
            return False

        if not self.config.ai_api_key:
            print(f"Error: OpenAI API key required", file=sys.stderr)
            return False

        try:
            self.openai_client = openai.OpenAI(api_key=self.config.ai_api_key)
            # Test with a simple request
            response = self.openai_client.chat.completions.create(
                model=self.summary_model,
                messages=[{"role": "user", "content": "Test"}],
                max_tokens=5
            )
            print(f"OpenAI connected successfully", file=sys.stderr)
            return True
        except Exception as e:
            print(f"Cannot connect to OpenAI: {e}", file=sys.stderr)
            return False

    def _initialize_claude(self) -> bool:
        """Initialize Claude (Anthropic) provider"""
        if not ANTHROPIC_AVAILABLE:
            print(f"Error: anthropic library not installed. Install with: pip install anthropic", file=sys.stderr)
            return False

        if not self.config.ai_api_key:
            print(f"Error: Anthropic API key required", file=sys.stderr)
            return False

        try:
            self.anthropic_client = anthropic.Anthropic(api_key=self.config.ai_api_key)
            # Test with a simple request
            response = self.anthropic_client.messages.create(
                model=self.summary_model,
                max_tokens=5,
                messages=[{"role": "user", "content": "Test"}]
            )
            print(f"Claude (Anthropic) connected successfully", file=sys.stderr)
            return True
        except Exception as e:
            print(f"Cannot connect to Claude: {e}", file=sys.stderr)
            return False

    def _load_prompts(self):
        """Load prompts from YAML files exactly like ContentStudio"""
        try:
            # Load YouTube prompts
            youtube_prompts_path = self.prompts_dir / "prompts.yml"
            if youtube_prompts_path.exists():
                with open(youtube_prompts_path, 'r', encoding='utf-8') as f:
                    self.youtube_prompts = yaml.safe_load(f)
                print(f"Loaded YouTube prompts from {youtube_prompts_path}", file=sys.stderr)
            else:
                print(f"Warning: YouTube prompts file not found at {youtube_prompts_path}", file=sys.stderr)

            # Load Spreaker prompts
            spreaker_prompts_path = self.prompts_dir / "spreaker_prompts.yml"
            if spreaker_prompts_path.exists():
                with open(spreaker_prompts_path, 'r', encoding='utf-8') as f:
                    self.spreaker_prompts = yaml.safe_load(f)
                print(f"Loaded Spreaker prompts from {spreaker_prompts_path}", file=sys.stderr)
            else:
                print(f"Warning: Spreaker prompts file not found at {spreaker_prompts_path}", file=sys.stderr)

            # Load summarization prompts
            summarization_prompts_path = self.prompts_dir / "summarization_prompts.yml"
            if summarization_prompts_path.exists():
                with open(summarization_prompts_path, 'r', encoding='utf-8') as f:
                    self.summarization_prompts = yaml.safe_load(f)
                print(f"Loaded summarization prompts from {summarization_prompts_path}", file=sys.stderr)
            else:
                print(f"Warning: Summarization prompts file not found at {summarization_prompts_path}", file=sys.stderr)

            # Load description links
            description_links_path = self.prompts_dir / "description_links.yml"
            if description_links_path.exists():
                with open(description_links_path, 'r', encoding='utf-8') as f:
                    data = yaml.safe_load(f)
                    self.description_links = data.get('description_links', '')
                print(f"Loaded description links from {description_links_path}", file=sys.stderr)
            else:
                print(f"Warning: Description links file not found at {description_links_path}", file=sys.stderr)

        except Exception as e:
            print(f"Error loading prompts: {e}", file=sys.stderr)
            # Set defaults if loading fails
            self.youtube_prompts = None
            self.spreaker_prompts = None
            self.summarization_prompts = None
            self.description_links = None

    def summarize_transcript(self, transcript: str, source_name: str) -> str:
        """Summarize transcript using fast model with chunking and temp files"""
        if len(transcript) <= 1000:
            return transcript

        print(f"Summarizing transcript ({len(transcript)} chars) from {source_name}", file=sys.stderr)

        # Create temp file for this transcript
        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', source_name)
        temp_file = self.temp_dir / f"summary_{safe_name}_{int(time.time())}.txt"

        try:
            # Handle large transcripts with chunking
            if len(transcript) > 8000:
                return self._summarize_large_transcript_chunked(transcript, source_name, temp_file)
            else:
                return self._summarize_single_chunk(transcript, source_name, temp_file)

        except Exception as e:
            print(f"Error during summarization: {e}", file=sys.stderr)
            return self._fallback_truncate(transcript, source_name)
        finally:
            # Clean up temp file
            if temp_file.exists():
                temp_file.unlink()

    def _summarize_large_transcript_chunked(self, transcript: str, source_name: str, temp_file: Path) -> str:
        """Summarize large transcript in chunks with temp file writing"""
        chunk_size = 8000
        chunks = []

        # Split into chunks
        for i in range(0, len(transcript), chunk_size):
            chunks.append(transcript[i:i + chunk_size])

        print(f"   Processing {len(chunks)} chunks...", file=sys.stderr)

        # Process each chunk and write to temp file
        with open(temp_file, 'w', encoding='utf-8') as f:
            for i, chunk in enumerate(chunks):
                try:
                    print(f"   Chunk {i+1}/{len(chunks)}", file=sys.stderr)

                    prompt = self._create_summarization_prompt(chunk, f"{source_name}_chunk_{i}")
                    response = self._make_request(prompt, model=self.summary_model, timeout=120)

                    if response and len(response.strip()) > 10:
                        # Write chunk summary to temp file
                        f.write(response.strip() + "\n\n")
                        f.flush()  # Ensure it's written immediately
                    else:
                        # Write fallback for failed chunk
                        fallback = self._fallback_truncate(chunk, f"{source_name}_chunk_{i}")
                        f.write(fallback + "\n\n")
                        f.flush()

                except Exception as e:
                    print(f"   Chunk {i} failed: {e}", file=sys.stderr)
                    fallback = self._fallback_truncate(chunk, f"{source_name}_chunk_{i}")
                    f.write(fallback + "\n\n")
                    f.flush()

        # Read back the combined summaries
        with open(temp_file, 'r', encoding='utf-8') as f:
            combined_summary = f.read().strip()

        # If combined summary is still too big, summarize again
        if len(combined_summary) > 15000:
            print(f"   Final summarization of combined chunks...", file=sys.stderr)
            final_summary = self._final_compression(combined_summary, source_name)
            return final_summary

        print(f"Transcript chunked and summarized: {len(transcript)} -> {len(combined_summary)} chars", file=sys.stderr)
        return combined_summary

    def _summarize_single_chunk(self, transcript: str, source_name: str, temp_file: Path) -> str:
        """Summarize single chunk and write to temp file"""
        prompt = self._create_summarization_prompt(transcript, source_name)
        response = self._make_request(prompt, model=self.summary_model, timeout=120)

        if response and len(response.strip()) > 10:
            # Write to temp file
            with open(temp_file, 'w', encoding='utf-8') as f:
                f.write(response.strip())

            print(f"Transcript summarized: {len(transcript)} -> {len(response)} chars", file=sys.stderr)
            return response.strip()
        else:
            print(f"Summarization failed, using fallback truncation", file=sys.stderr)
            fallback = self._fallback_truncate(transcript, source_name)

            # Write fallback to temp file
            with open(temp_file, 'w', encoding='utf-8') as f:
                f.write(fallback)

            return fallback

    def _final_compression(self, combined_summary: str, source_name: str) -> str:
        """Final compression if combined summary is still too large - from YAML"""
        try:
            if not self.summarization_prompts:
                raise ValueError("Summarization prompts not loaded. Cannot compress without prompts.")

            prompt_template = self.summarization_prompts.get('final_compression_prompt', '')
            if not prompt_template:
                raise ValueError("final_compression_prompt not found in summarization prompts YAML file")

            prompt = prompt_template.format(
                source_name=source_name,
                combined_summary=combined_summary
            )

            response = self._make_request(prompt, model=self.summary_model, timeout=180)

            if response and len(response.strip()) > 10:
                print(f"Final compression: {len(combined_summary)} -> {len(response)} chars", file=sys.stderr)
                return response.strip()
            else:
                # Fallback to truncation
                return combined_summary[:12000] + "... [TRUNCATED]"

        except Exception as e:
            print(f"Final compression failed: {e}", file=sys.stderr)
            return combined_summary[:12000] + "... [TRUNCATED]"

    def generate_metadata(self, content: str, platform: str, source_filename: Optional[str] = None) -> ConsolidatedResult:
        """
        Generate all metadata components in single JSON request using smart model

        Args:
            content: The content to analyze (transcript or summary)
            platform: Target platform ('youtube' or 'spreaker')
            source_filename: Optional filename for context (exactly like ContentStudio)

        Returns:
            ConsolidatedResult with metadata dictionary
        """
        print(f"Starting consolidated metadata generation for {platform}...", file=sys.stderr)

        start_time = time.time()

        try:
            # Add filename context if provided (EXACTLY like ContentStudio)
            content_with_context = content
            if source_filename:
                content_with_context = f"[Source filename: {source_filename}]\n\n{content}"
                print(f"   Added filename context: {source_filename}", file=sys.stderr)

            # Build platform-specific prompt
            consolidated_prompt = self._build_consolidated_prompt(content_with_context, platform)

            # Make single AI request with smart model
            print(f"   Making consolidated request...", file=sys.stderr)
            response = self._make_request(consolidated_prompt, model=self.metadata_model, timeout=300)
            processing_time = time.time() - start_time

            if not response:
                return ConsolidatedResult(
                    metadata={},
                    success=False,
                    processing_time=processing_time,
                    fixes_applied=[],
                    error="Empty response from AI"
                )

            print(f"   Response received ({len(response)} chars)", file=sys.stderr)

            # Parse and validate JSON response
            metadata, fixes_applied = self._parse_and_validate_response(response, platform)

            if not metadata:
                return ConsolidatedResult(
                    metadata={},
                    success=False,
                    processing_time=processing_time,
                    fixes_applied=fixes_applied,
                    error="Failed to parse or validate JSON response"
                )

            # Add description links (EXACTLY like ContentStudio)
            metadata = self._add_description_links(metadata)

            print(f"   Consolidated generation completed", file=sys.stderr)
            if fixes_applied:
                print(f"   Applied {len(fixes_applied)} auto-fixes", file=sys.stderr)

            return ConsolidatedResult(
                metadata=metadata,
                success=True,
                processing_time=processing_time,
                fixes_applied=fixes_applied
            )

        except Exception as e:
            processing_time = time.time() - start_time
            print(f"Error in metadata generation: {e}", file=sys.stderr)
            return ConsolidatedResult(
                metadata={},
                success=False,
                processing_time=processing_time,
                fixes_applied=[],
                error=str(e)
            )

    def _build_consolidated_prompt(self, content: str, platform: str) -> str:
        """Build consolidated prompt based on platform - EXACTLY like ContentStudio"""

        if platform.lower() == 'youtube':
            return self._build_youtube_prompt_from_yaml(content)
        elif platform.lower() == 'spreaker':
            return self._build_spreaker_prompt_from_yaml(content)
        else:
            # Default to YouTube
            return self._build_youtube_prompt_from_yaml(content)

    def _extract_keywords_from_content(self, content: str) -> Tuple[List[str], List[str]]:
        """Extract primary and secondary keywords from content - EXACTLY like ContentStudio"""
        content_lower = content.lower()

        # Common political figures
        political_figures = ['trump', 'biden', 'nancy mace', 'desantis', 'harris', 'pelosi', 'aoc', 'mcconnell']
        # Common issues/topics
        political_topics = ['immigration', 'healthcare', 'economy', 'climate', 'abortion', 'gun', 'tax', 'vote', 'election']
        # Atheist topics
        atheist_topics = ['religion', 'god', 'atheist', 'atheism', 'christian', 'faith', 'bible', 'prayer', 'church']
        # Conspiracy topics
        conspiracy_topics = ['chemtrails', 'fluoride', 'vaccine', 'conspiracy', '5g', 'qanon']

        primary_keywords = []
        secondary_keywords = []

        # Find political figures (primary keywords)
        for figure in political_figures:
            if figure in content_lower:
                primary_keywords.append(figure)

        # Find main topics (secondary keywords)
        all_topics = political_topics + atheist_topics + conspiracy_topics
        for topic in all_topics:
            if topic in content_lower:
                secondary_keywords.append(topic)

        # Extract proper nouns (likely to be important)
        words = content.split()
        for word in words:
            if len(word) > 3 and word[0].isupper() and word.lower() not in [k.lower() for k in primary_keywords]:
                if len(primary_keywords) < 2:
                    primary_keywords.append(word)
                elif len(secondary_keywords) < 3:
                    secondary_keywords.append(word)

        return primary_keywords[:2], secondary_keywords[:3]

    def _build_youtube_prompt_from_yaml(self, content: str) -> str:
        """Build YouTube prompt from YAML file - EXACTLY like ContentStudio"""

        if not self.youtube_prompts:
            raise ValueError("YouTube prompts not loaded. Cannot generate metadata without prompts.")

        # Get the consolidated_prompt template from YAML
        consolidated_template = self.youtube_prompts.get('consolidated_prompt', '')
        base_instructions = self.youtube_prompts.get('base_instructions', '')

        if not consolidated_template:
            raise ValueError("consolidated_prompt not found in YouTube prompts YAML file")

        # Format the prompt exactly like ContentStudio does
        prompt = consolidated_template.format(
            base_instructions=base_instructions,
            content=content,
            mode='individual'  # Always individual for single content items
        )

        # Extract keywords for multiplier system (optional enhancement)
        primary_keywords, secondary_keywords = self._extract_keywords_from_content(content)

        # Add keyword multiplier instructions if keywords found
        if primary_keywords or secondary_keywords:
            keyword_addition = self.youtube_prompts.get('keyword_multiplier_addition', '')
            if keyword_addition:
                keyword_instructions = keyword_addition.format(
                    primary_keywords=', '.join(primary_keywords) if primary_keywords else 'auto-detect',
                    secondary_keywords=', '.join(secondary_keywords) if secondary_keywords else 'auto-detect'
                )
                prompt = prompt + "\n\n" + keyword_instructions

        return prompt

    def _build_spreaker_prompt_from_yaml(self, content: str) -> str:
        """Build Spreaker prompt from YAML file - EXACTLY like ContentStudio"""

        if not self.spreaker_prompts:
            raise ValueError("Spreaker prompts not loaded. Cannot generate metadata without prompts.")

        # Get the consolidated_prompt template from YAML
        consolidated_template = self.spreaker_prompts.get('consolidated_prompt', '')
        base_instructions = self.spreaker_prompts.get('base_instructions', '')

        if not consolidated_template:
            raise ValueError("consolidated_prompt not found in Spreaker prompts YAML file")

        # Format the prompt exactly like ContentStudio does
        prompt = consolidated_template.format(
            base_instructions=base_instructions,
            content=content,
            mode='individual'  # Always individual for single content items
        )

        # Extract keywords for multiplier system (optional enhancement)
        primary_keywords, secondary_keywords = self._extract_keywords_from_content(content)

        # Add keyword multiplier instructions if keywords found
        if primary_keywords or secondary_keywords:
            keyword_addition = self.spreaker_prompts.get('keyword_multiplier_addition', '')
            if keyword_addition:
                keyword_instructions = keyword_addition.format(
                    primary_keywords=', '.join(primary_keywords) if primary_keywords else 'auto-detect',
                    secondary_keywords=', '.join(secondary_keywords) if secondary_keywords else 'auto-detect'
                )
                prompt = prompt + "\n\n" + keyword_instructions

        return prompt

    def _make_request(self, prompt: str, model: str = None, timeout: int = 60) -> Optional[str]:
        """Make a request to the AI model based on provider"""

        if model is None:
            model = self.current_model or self.metadata_model

        try:
            if self.provider == 'ollama':
                return self._make_ollama_request(prompt, model, timeout)
            elif self.provider == 'openai':
                return self._make_openai_request(prompt, model, timeout)
            elif self.provider == 'claude':
                return self._make_claude_request(prompt, model, timeout)
            else:
                print(f"Unknown provider: {self.provider}", file=sys.stderr)
                return None

        except Exception as e:
            print(f"Request failed: {e}", file=sys.stderr)
            return None

    def _make_ollama_request(self, prompt: str, model: str, timeout: int) -> Optional[str]:
        """Make request to Ollama"""
        try:
            response = requests.post(
                f"{self.config.ollama_base_url}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                },
                timeout=timeout
            )

            if response.status_code == 200:
                result = response.json()
                return result.get('response', '').strip()
            else:
                print(f"Ollama request failed: HTTP {response.status_code}", file=sys.stderr)
                return None

        except Exception as e:
            print(f"Ollama request error: {e}", file=sys.stderr)
            return None

    def _make_openai_request(self, prompt: str, model: str, timeout: int) -> Optional[str]:
        """Make request to OpenAI"""
        try:
            response = self.openai_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are an expert in content metadata generation."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.7,
                timeout=timeout
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"OpenAI request error: {e}", file=sys.stderr)
            return None

    def _make_claude_request(self, prompt: str, model: str, timeout: int) -> Optional[str]:
        """Make request to Claude (Anthropic)"""
        try:
            response = self.anthropic_client.messages.create(
                model=model,
                max_tokens=4096,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                timeout=timeout
            )
            return response.content[0].text.strip()
        except Exception as e:
            print(f"Claude request error: {e}", file=sys.stderr)
            return None

    def _create_summarization_prompt(self, transcript: str, source_name: str) -> str:
        """Create prompt for transcript summarization with filename context - from YAML"""
        if not self.summarization_prompts:
            raise ValueError("Summarization prompts not loaded. Cannot summarize without prompts.")

        prompt_template = self.summarization_prompts.get('summarization_prompt', '')
        if not prompt_template:
            raise ValueError("summarization_prompt not found in summarization prompts YAML file")

        return prompt_template.format(
            source_name=source_name,
            transcript=transcript
        )

    def _fallback_truncate(self, transcript: str, source_name: str) -> str:
        """Fallback truncation when AI summarization fails"""
        sentences = transcript.split('.')
        result = []
        current_length = 0

        for sentence in sentences[:8]:
            sentence = sentence.strip()
            if current_length + len(sentence) < 400:
                result.append(sentence)
                current_length += len(sentence)
            else:
                break

        truncated = '. '.join(result) + '.'
        truncated += f" [Truncated from {len(transcript)} chars - {source_name}]"
        return truncated

    def _parse_and_validate_response(self, response: str, platform: str) -> Tuple[Optional[Dict], List[str]]:
        """Parse JSON response and validate without adding content"""

        # Parse JSON
        metadata = self._parse_json_response(response)
        if not metadata:
            return None, ["Failed to parse JSON response"]

        # Validate with minimal fixes
        fixes_applied = self._validate_and_fix(metadata, platform)

        return metadata, fixes_applied

    def _parse_json_response(self, response: str) -> Optional[Dict]:
        """Parse JSON response from AI"""
        try:
            # Clean response
            cleaned_response = response.strip()

            # Remove code blocks if present
            if cleaned_response.startswith('```'):
                lines = cleaned_response.split('\n')
                start_idx = 0
                end_idx = len(lines)

                for i, line in enumerate(lines):
                    if line.strip().startswith('```'):
                        if start_idx == 0:
                            start_idx = i + 1
                        else:
                            end_idx = i
                            break

                cleaned_response = '\n'.join(lines[start_idx:end_idx])

            # Find JSON
            json_start = cleaned_response.find('{')
            json_end = cleaned_response.rfind('}') + 1

            if json_start >= 0 and json_end > json_start:
                json_text = cleaned_response[json_start:json_end]
                return json.loads(json_text)

            return None

        except json.JSONDecodeError as e:
            print(f"JSON decode error: {e}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"Parse error: {e}", file=sys.stderr)
            return None

    def _validate_and_fix(self, metadata: Dict, platform: str) -> List[str]:
        """Validate with minimal fixes - no content additions"""

        fixes_applied = []

        # Validate and fix thumbnail text
        fixes_applied.extend(self._fix_thumbnail_text(metadata))

        # Validate and fix titles
        fixes_applied.extend(self._fix_titles(metadata))

        # Validate tags
        fixes_applied.extend(self._fix_tags(metadata))

        # Validate hashtags
        fixes_applied.extend(self._fix_hashtags(metadata))

        # Validate description
        fixes_applied.extend(self._fix_description(metadata))

        return fixes_applied

    def _fix_thumbnail_text(self, metadata: Dict) -> List[str]:
        """Fix thumbnail text - convert to uppercase only"""
        fixes = []

        thumbnail_text = metadata.get('thumbnail_text', [])
        if not isinstance(thumbnail_text, list):
            thumbnail_text = []
            metadata['thumbnail_text'] = thumbnail_text
            fixes.append("Fixed non-list thumbnail_text")

        # Convert to uppercase only
        uppercase_thumbnails = []
        for text in thumbnail_text:
            if isinstance(text, str):
                uppercase_thumbnails.append(text.upper())
            else:
                uppercase_thumbnails.append(str(text).upper())

        metadata['thumbnail_text'] = uppercase_thumbnails
        return fixes

    def _fix_titles(self, metadata: Dict) -> List[str]:
        """Fix titles - basic validation only"""
        fixes = []

        titles = metadata.get('titles', [])
        if not isinstance(titles, list):
            titles = []
            metadata['titles'] = titles
            fixes.append("Fixed non-list titles")

        # Remove invalid entries only
        original_count = len(titles)
        valid_titles = []

        for title in titles:
            if isinstance(title, str) and title.strip():
                valid_titles.append(title.strip())

        if len(valid_titles) < original_count:
            fixes.append(f"Removed {original_count - len(valid_titles)} invalid title entries")

        metadata['titles'] = valid_titles
        return fixes

    def _fix_tags(self, metadata: Dict) -> List[str]:
        """Fix tags - ensure proper format"""
        fixes = []

        tags = metadata.get('tags', '')
        if isinstance(tags, list):
            # Convert list to comma-separated string
            tags = ', '.join(str(tag).strip() for tag in tags if str(tag).strip())
            metadata['tags'] = tags
            fixes.append("Converted tags list to comma-separated string")
        elif not isinstance(tags, str):
            metadata['tags'] = ''
            fixes.append("Fixed invalid tags format")

        return fixes

    def _fix_hashtags(self, metadata: Dict) -> List[str]:
        """Fix hashtags - ensure # symbols"""
        fixes = []

        hashtags = metadata.get('hashtags', '')

        if isinstance(hashtags, list):
            # Ensure each has # symbol
            fixed_hashtags = []
            for tag in hashtags:
                tag = str(tag).strip()
                if tag and not tag.startswith('#'):
                    tag = '#' + tag
                if tag:
                    fixed_hashtags.append(tag)
            metadata['hashtags'] = ' '.join(fixed_hashtags)
            fixes.append("Converted hashtags list to space-separated string with # symbols")
        elif isinstance(hashtags, str):
            # Ensure hashtags have # symbols
            tags = hashtags.split()
            fixed_hashtags = []
            for tag in tags:
                tag = tag.strip()
                if tag and not tag.startswith('#'):
                    tag = '#' + tag
                if tag:
                    fixed_hashtags.append(tag)
            metadata['hashtags'] = ' '.join(fixed_hashtags)
        else:
            metadata['hashtags'] = ''
            fixes.append("Fixed invalid hashtags format")

        return fixes

    def _fix_description(self, metadata: Dict) -> List[str]:
        """Fix description - basic validation"""
        fixes = []

        description = metadata.get('description', '')
        if not isinstance(description, str):
            metadata['description'] = str(description)
            fixes.append("Converted description to string")

        return fixes

    def _add_description_links(self, metadata: Dict) -> Dict:
        """Add description links to metadata (EXACTLY like ContentStudio)"""
        if 'description' not in metadata:
            return metadata

        description_parts = [metadata['description']]

        # Add hashtags if present (they should already be in separate field)
        # Note: Hashtags are already in metadata, we just keep them separate

        # Add description links if loaded
        if self.description_links:
            description_parts.append('\n\n' + self.description_links)
            print(f"   Added description links to metadata", file=sys.stderr)

        metadata['description'] = ''.join(description_parts)
        return metadata

    def cleanup(self):
        """Clean up all resources"""
        print("Cleaning up AI Manager...", file=sys.stderr)

        try:
            # Provider-specific cleanup
            if self.provider == 'ollama':
                self._cleanup_ollama()

            # Reset state
            self.current_model = None
            self.model_ready = False
            self.openai_client = None
            self.anthropic_client = None

            # Clean temp files
            try:
                for temp_file in self.temp_dir.glob("summary_*.txt"):
                    temp_file.unlink()
            except Exception as e:
                print(f"Warning: Could not clean temp files: {e}", file=sys.stderr)

            print("AI Manager cleanup complete", file=sys.stderr)

        except Exception as e:
            print(f"Cleanup completed with warnings: {e}", file=sys.stderr)

    def _cleanup_ollama(self):
        """Cleanup Ollama-specific resources - keep model loaded for reuse"""
        # Keep the model loaded for 5 minutes (300s) to avoid unloading/reloading
        # between jobs in a queue. The model will auto-unload after 5 minutes of inactivity.
        if self.current_model:
            try:
                for attempt in range(3):
                    try:
                        response = requests.post(
                            f"{self.config.ollama_base_url}/api/generate",
                            json={
                                "model": self.current_model,
                                "prompt": "",
                                "keep_alive": "5m"  # Keep model loaded for 5 minutes
                            },
                            timeout=30
                        )
                        if response.status_code == 200:
                            break
                    except:
                        if attempt < 2:
                            time.sleep(1)
                        continue
            except:
                pass  # Ignore all errors

    def get_status(self) -> Dict[str, any]:
        """Get current AI manager status"""
        return {
            "provider": self.provider,
            "current_model": self.current_model,
            "model_ready": self.model_ready,
            "summary_model": self.summary_model,
            "metadata_model": self.metadata_model,
            "platform": self.platform,
            "openai_available": OPENAI_AVAILABLE,
            "anthropic_available": ANTHROPIC_AVAILABLE
        }
