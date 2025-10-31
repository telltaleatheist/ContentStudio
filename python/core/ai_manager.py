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
        """Final compression if combined summary is still too large"""
        try:
            prompt = f"""This is a combined summary from multiple chunks of a long transcript. Compress this into a concise 2-3 paragraph summary that captures the main topics, key points, and important names mentioned.

Source: {source_name}

Combined Summary:
{combined_summary}

Compressed Summary:"""

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

    def generate_metadata(self, content: str, platform: str) -> ConsolidatedResult:
        """
        Generate all metadata components in single JSON request using smart model

        Args:
            content: The content to analyze (transcript or summary)
            platform: Target platform ('youtube' or 'spreaker')

        Returns:
            ConsolidatedResult with metadata dictionary
        """
        print(f"Starting consolidated metadata generation for {platform}...", file=sys.stderr)

        start_time = time.time()

        try:
            # Build platform-specific prompt
            consolidated_prompt = self._build_consolidated_prompt(content, platform)

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
        """Build consolidated prompt based on platform"""

        if platform.lower() == 'youtube':
            return self._build_youtube_prompt(content)
        elif platform.lower() == 'spreaker':
            return self._build_spreaker_prompt(content)
        else:
            # Default to YouTube
            return self._build_youtube_prompt(content)

    def _build_youtube_prompt(self, content: str) -> str:
        """Build YouTube-specific metadata generation prompt"""

        base_instructions = """You know exactly how YouTube works in 2025 - the algorithm, what gets people to click, all of it.

EDITORIAL VOICE: Progressive, grounded in evidence, with a focus on holding people accountable.
This applies to everything - politics, social media drama, celebrity stuff, pop culture, whatever's happening.

CORE APPROACH:
- Lead with facts and evidence, not hype or guessing
- Call out what matters - real consequences, actual impact
- Give people the full picture, not just surface drama
- Be skeptical but fair when analyzing what people say and do
- Trust science when it's relevant

HOW THE ALGORITHM WORKS:
- Repeating keywords across title, description, and tags multiplies your reach
- Layer your tags from specific to broad for maximum discovery
- Mobile users see the first part of your title first - make it count
- Engagement matters, but so does authenticity - the algorithm can tell when you're faking it"""

        prompt = f"""{base_instructions}

CONTENT: {content}

CONTENT ANALYSIS & FRAMING:
Analyze the content and determine appropriate framing based on what's happening:

ACCOUNTABILITY FRAMING (person doing something questionable):
- Use: CAUGHT, EXPOSED, FAILS, BACKFIRES, CALLED OUT, CONSEQUENCES
- Focus on impact and accountability
- Highlight real-world effects of actions/statements

DEBUNKING FRAMING (false claims or misinformation):
- Use: DEBUNKED, BUSTED, TRUTH, REALITY CHECK, CORRECTED, FACTS
- Emphasize evidence and factual accuracy
- Contrast claims with actual reality

BREAKING NEWS FRAMING (new developments):
- Use: BREAKING, LEAKED, REVEALED, SHOCKING, URGENT, DEVELOPING
- Create appropriate urgency without overselling
- Focus on why this matters now

ANALYSIS FRAMING (providing context/explanation):
- Use: EXPLAINED, ANALYZED, TRUTH ABOUT, REALITY OF, BEHIND THE SCENES
- Emphasize deeper understanding and context
- Educational but engaging approach

KEYWORD MULTIPLIER SYSTEM:
1. Identify 1-2 PRIMARY keywords (person names, main topics, events)
2. Identify 2-3 SECONDARY keywords (related concepts, consequences, context)
3. PRIMARY keywords must appear in: title, description opening, 5-6 tags, thumbnail text
4. SECONDARY keywords must appear in: title/description, 3-4 tags each

GENERATION REQUIREMENTS:

THUMBNAIL TEXT (10 options, max 3 words, ALL CAPS):
- Create urgency and emotional response appropriate to content
- Universal high-engagement options: EXPOSED, CAUGHT, FAILS, TRUTH, BUSTED, REALITY, BROKEN, LEAKED, CALLED OUT, CONSEQUENCES
- Match the framing (accountability vs debunking vs breaking news)

TITLES (10 options, 50-60 characters ideal, max 70):

CRITICAL: Title Case only. Zero ALL CAPS words allowed.
If any word is in ALL CAPS, the title is invalid.

Guidelines:
- Front-load primary keyword (first 30 characters = mobile visibility)
- Be specific over generic (numbers, names, concrete details)
- Shorter is better - aim for 50-60 characters, not max length
- Clear value: what does the viewer learn or discover?

Avoid these clickbait patterns:
- Overused words: DEBUNKED, DEBUNKING, EXPOSED, BUSTED, DESTROYED, SLAMMED
- ALL CAPS words anywhere in title
- Multiple punctuation (!!!, ???, ...)
- Prefixes like "BREAKING:" or "EXPOSED:" or "The Truth About"
- Vague academic language ("misrepresents", "distorts reality")

Strong title patterns:
- "5 Evolution Facts Chick Tracts Get Wrong"
- "Trump's $120k Claim: What IRS Data Shows"
- "Biologist Reads Chick Tract: The Problems"
- "Why RFK Jr. Dodges Vaccine Questions"
- "Science vs Chick Tracts: What Evidence Shows"

Be direct, specific, and honest. Front-load the topic. Keep it tight.

DESCRIPTION (complete, no length limit):
- First 125 characters: primary keyword + hook
- Provide context and analysis beyond surface drama
- Include evidence-based perspective
- Engagement CTA and subscription request
- NO timestamps, time markers, or "Timestamps:" sections
- NO ellipsis truncation
- CRITICAL: Do NOT add hashtags to description - hashtags are generated separately
- Keep description focused on content explanation and call-to-action only

TAGS (exactly 15 tags, strategic pyramid):
- Layer 1 (1-3): Exact match, primary keywords
- Layer 2 (4-8): Variations, synonyms, word changes
- Layer 3 (9-12): Long-tail, natural language
- Layer 4 (13-15): Broad categories, discovery terms

HASHTAGS (10 hashtags with # symbols):
- First 3 appear above title - make them impactful
- Mix broad and specific hashtags
- Include trending relevant hashtags when appropriate

OUTPUT FORMAT - JSON ONLY:
Use only ASCII characters (A-Z, a-z, 0-9, basic punctuation). No emojis or special symbols.

{{
  "thumbnail_text": [10 content-specific options, ALL CAPS, max 3 words],
  "titles": [10 titles, EXACTLY 45-70 characters each],
  "description": "Complete description, no timestamps, no ellipsis, no hashtags",
  "tags": "15 comma-separated tags implementing pyramid structure",
  "hashtags": "10 hashtags with # symbols"
}}

CRITICAL INSTRUCTIONS:
- Analyze what the person/situation actually represents
- Apply appropriate framing based on content analysis
- Generate content-specific metadata that matches the actual subject matter
- Implement keyword multiplier system for algorithm optimization

DO NOT INCLUDE:
- Timestamps (0:00, 2:15, etc.)
- "Timestamps:" sections
- Time markers of any kind
- Ellipsis (...) in titles or descriptions
- Hashtags in the description field (hashtags go in separate field)

Respond with ONLY the JSON object."""

        return prompt

    def _build_spreaker_prompt(self, content: str) -> str:
        """Build Spreaker (podcast) specific metadata generation prompt"""

        prompt = f"""You are an expert in podcast metadata optimization for Spreaker platform.

CONTENT: {content}

Generate podcast metadata optimized for discoverability and engagement on Spreaker.

PODCAST METADATA REQUIREMENTS:

EPISODE TITLES (10 options, 50-70 characters):
- Clear, descriptive, SEO-friendly
- Front-load main topic or guest name
- Include episode type when relevant (Interview, Solo, Q&A)
- Avoid clickbait but remain engaging

THUMBNAIL TEXT (10 options, max 3 words, ALL CAPS):
- Guest names or main topics
- Episode themes
- Key takeaways
- Format: INTERVIEW, SOLO SHOW, Q&A, etc.

DESCRIPTION (complete, no length limit):
- First paragraph: Hook with main topic and value proposition
- Key topics covered in episode
- Guest bio/credentials (if applicable)
- Call to action (subscribe, rate, review)
- NO timestamps (Spreaker adds these automatically)
- Include relevant links placeholder text

TAGS (exactly 15 tags):
- Topic-specific keywords
- Genre tags
- Guest-related tags (if applicable)
- Broad discovery terms
- Industry-relevant keywords

HASHTAGS (10 hashtags with # symbols):
- Platform-specific hashtags
- Topic and niche hashtags
- Trending relevant hashtags
- Community hashtags

OUTPUT FORMAT - JSON ONLY:
{{
  "thumbnail_text": [10 options, ALL CAPS, max 3 words],
  "titles": [10 titles, 50-70 characters each],
  "description": "Complete description without timestamps",
  "tags": "15 comma-separated tags",
  "hashtags": "10 hashtags with # symbols"
}}

Respond with ONLY the JSON object."""

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
        """Create prompt for transcript summarization with filename context"""
        return f"""Summarize this transcript into 2-3 detailed sentences that capture the main topics, key points, and any important names or events mentioned. Focus on what would be relevant for creating content metadata.

The source filename provides context about the content: {source_name}

Transcript:
{transcript}

Summary:"""

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
        """Cleanup Ollama-specific resources"""
        if self.current_model:
            try:
                for attempt in range(3):
                    try:
                        response = requests.post(
                            f"{self.config.ollama_base_url}/api/generate",
                            json={
                                "model": self.current_model,
                                "prompt": "",
                                "keep_alive": 0
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
                pass  # Ignore all unload errors

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
