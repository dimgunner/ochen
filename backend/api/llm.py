"""
LLM proxy for metaphor interpretation.

The service never generates artwork: the LLM only picks existing assets
from the built-in library. Every returned asset id is validated against
the library whitelist, and any unknown id is discarded.

Settings are read from the environment so the same image works with any
OpenAI-compatible provider:

    LLM_BASE_URL  e.g. https://api.openai.com/v1
    LLM_MODEL     e.g. gpt-4o-mini
    LLM_API_KEY   provider api key
    LLM_TIMEOUT   request timeout in seconds (default 20)
    LLM_MAX_OBJECTS  how many main objects may be selected (default 3)
"""

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a composition assistant for a library of vector illustrations. "
    "Given a metaphor or headline, choose which library objects illustrate it. "
    "You MUST answer with JSON only, no prose, using this exact shape:\n"
    '{"objects": [{"assetId": "<id>", "role": "main|background", "reason": "<short explanation>"}]}\n'
    "Rules:\n"
    "- Use only asset ids listed in the catalog.\n"
    "- Pick at most {max_objects} objects with role 'main'.\n"
    "- Use role 'background' only for objects that may sit behind the main ones.\n"
    "- Never invent new objects, never return SVG or markup."
)


def get_settings():
    """Read LLM configuration from the environment."""
    from django.conf import settings

    def pick(name, fallback_value=''):
        value = os.environ.get(name)
        if value is None:
            value = getattr(settings, name, fallback_value)
        return (value or '').strip()

    base_url = pick('LLM_BASE_URL').rstrip('/')
    model = pick('LLM_MODEL')
    api_key = pick('LLM_API_KEY')

    try:
        timeout = float(pick('LLM_TIMEOUT', '20') or 20)
    except ValueError:
        timeout = 20.0
    try:
        max_objects = int(pick('LLM_MAX_OBJECTS', '3') or 3)
    except ValueError:
        max_objects = 3

    return {
        'base_url': base_url,
        'model': model,
        'api_key': api_key,
        'timeout': timeout,
        'max_objects': max(1, max_objects),
    }


def is_configured():
    """True when the provider can be called."""
    cfg = get_settings()
    return bool(cfg['base_url'] and cfg['model'] and cfg['api_key'])


PROVIDER_NAMES = {
    'api.openai.com': 'OpenAI',
    'router.huggingface.co': 'Hugging Face Router',
    'api.sambanova.ai': 'SambaNova',
    'api.mistral.ai': 'Mistral',
    'api.deepseek.com': 'DeepSeek',
    'api.fireworks.ai': 'Fireworks AI',
    'generativelanguage.googleapis.com': 'Google Gemini',
    'api.cloudflare.com': 'Cloudflare Workers AI',
}


def provider_name(base_url):
    """Human-readable provider name for a configured base URL."""
    from urllib.parse import urlparse

    host = urlparse(base_url or '').hostname or (base_url or '')
    return PROVIDER_NAMES.get(host, host or 'unknown')


def build_catalog(variants):
    """
    Build a compact catalog for the prompt.

    Only main-state variants are offered: the role decides which state is
    used downstream, so the model never has to know about L/S duplication.
    """
    seen = {}
    for v in variants:
        if v.get('state') != 'main':
            continue
        asset_id = v.get('assetId')
        if not asset_id or asset_id in seen:
            continue
        seen[asset_id] = {
            'assetId': asset_id,
            'name': v.get('name', ''),
            'synonyms': v.get('synonyms', []),
            'tags': v.get('tags', []),
        }
    return list(seen.values())


def validate_objects(raw, allowed_ids, max_objects):
    """
    Validate the model answer against the library whitelist.

    Returns (objects, errors). Unknown ids and invalid roles are dropped.
    """
    errors = []
    objects = []
    seen = set()

    if not isinstance(raw, list):
        return [], ['objects is not a list']

    for item in raw:
        if not isinstance(item, dict):
            errors.append('object entry is not an object')
            continue

        asset_id = item.get('assetId')
        role = item.get('role', 'main')

        if not isinstance(asset_id, str) or not asset_id:
            errors.append('missing assetId')
            continue
        if asset_id not in allowed_ids:
            errors.append('unknown assetId: %s' % asset_id)
            continue
        if role not in ('main', 'background'):
            errors.append('invalid role for %s: %s' % (asset_id, role))
            continue
        if asset_id in seen:
            continue

        seen.add(asset_id)
        objects.append({
            'assetId': asset_id,
            'role': role,
            'reason': str(item.get('reason', ''))[:200],
        })

    mains = [o for o in objects if o['role'] == 'main']
    if len(mains) > max_objects:
        errors.append('too many main objects, truncated to %d' % max_objects)
        objects = [o for o in objects if o['role'] != 'main'] + mains[:max_objects]

    return objects, errors


def call_llm(text, catalog, max_objects, timeout):
    """
    Call the OpenAI-compatible chat completions endpoint.

    Returns (objects, errors). Raises RuntimeError on transport failures.
    """
    cfg = get_settings()
    url = cfg['base_url'] + '/chat/completions'

    # The prompt contains literal JSON braces, so str.format() would try to
    # interpret them as fields. Substitute the one placeholder directly.
    prompt = SYSTEM_PROMPT.replace('{max_objects}', str(max_objects))

    payload = {
        'model': cfg['model'],
        'temperature': 0,
        'messages': [
            {'role': 'system', 'content': prompt},
            {'role': 'user', 'content': json.dumps({
                'text': text,
                'catalog': catalog,
            }, ensure_ascii=False)},
        ],
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg['api_key'],
        },
        method='POST',
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode('utf-8'))

    content = body['choices'][0]['message']['content']
    # The caller expects a (payload, errors) tuple. Transport and parsing
    # failures are raised, so there are no non-fatal errors at this point.
    return parse_json_object(content), []


def parse_json_object(content):
    """
    Extract a JSON object from a model response.

    Tolerates markdown code fences and leading prose.
    """
    if not isinstance(content, str):
        raise RuntimeError('empty model response')

    text = content.strip()

    if text.startswith('```'):
        # strip ```json ... ``` fences
        text = text.split('\n', 1)[-1] if '\n' in text else text
        text = text.rsplit('```', 1)[0]

    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError('no JSON object in model response')

    return json.loads(text[start:end + 1])
