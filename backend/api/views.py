from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
import json
import logging
from pathlib import Path

from . import fallback
from . import llm

logger = logging.getLogger(__name__)

MANIFEST_CANDIDATES = (
    Path('/app/static/assets/manifest.json'),
    Path(__file__).resolve().parent.parent.parent / 'static' / 'assets' / 'manifest.json',
)

_manifest_cache = {}


def load_manifest():
    """Load and cache the library manifest."""
    if 'data' in _manifest_cache:
        return _manifest_cache['data']
    for path in MANIFEST_CANDIDATES:
        if path.exists():
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
            _manifest_cache['data'] = data
            return data
    return {'variants': []}


@csrf_exempt
def health(request):
    cfg = llm.get_settings()
    return JsonResponse({
        'status': 'ok',
        'llm_configured': llm.is_configured(),
        'llm_model': cfg['model'] or None,
    })


@csrf_exempt
def manifest(request):
    try:
        return JsonResponse(load_manifest())
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
def interpret_metaphor(request):
    """
    Interpret a metaphor or headline and return the library objects to use.

    The LLM only selects existing assets; the response is validated against
    the library whitelist. On any provider failure the local semantic
    fallback takes over so the feature keeps working offline.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    try:
        payload = json.loads(request.body or b'{}')
    except Exception:
        return JsonResponse({'error': 'invalid JSON body'}, status=400)

    text = (payload.get('text') or '').strip()
    if not text:
        return JsonResponse({'error': 'text is required'}, status=400)

    library = load_manifest()
    variants = library.get('variants', [])
    cfg = llm.get_settings()

    allowed_ids = {v['assetId'] for v in variants if v.get('state') == 'main'}

    # ---- try the LLM provider ----
    if llm.is_configured():
        catalog = llm.build_catalog(variants)
        try:
            raw, errors = llm.call_llm(text, catalog, cfg['max_objects'], cfg['timeout'])
            objects, validation_errors = llm.validate_objects(
                raw.get('objects', []), allowed_ids, cfg['max_objects']
            )
            if objects:
                return JsonResponse({
                    'objects': objects,
                    'source': 'llm',
                    'reason': objects[0].get('reason', ''),
                    'warnings': validation_errors,
                })
            logger.warning('LLM returned no usable objects: %s', validation_errors)
        except Exception:
            logger.exception('LLM request failed, falling back to local matching')
    else:
        logger.info('LLM is not configured, using local fallback')

    # ---- local semantic fallback ----
    index = fallback.build_index(variants)
    matched = fallback.match(text, index, cfg['max_objects'])
    objects = [{'assetId': asset_id, 'role': 'main', 'reason': 'local semantic match'} for asset_id in matched]

    # Give the composition a background layer as well.
    if objects:
        background = fallback.pick_background(
            text, index, set(matched), library.get('defaultBackground'),
            fallback.build_background_index(variants),
        )
        if background:
            objects.append({
                'assetId': background,
                'role': 'background',
                'reason': 'local semantic match',
            })

    if not objects:
        return JsonResponse({
            'objects': [],
            'source': 'local_fallback',
            'error': 'no matching objects for this text',
        }, status=200)

    return JsonResponse({
        'objects': objects,
        'source': 'local_fallback',
        'reason': 'local semantic match',
    })
