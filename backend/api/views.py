from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST
import json
import logging
import time
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


def client_ip(request):
    if getattr(settings, 'TRUST_PROXY_HEADERS', False):
        forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
        if forwarded:
            return forwarded.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', 'unknown')


def is_rate_limited(request):
    """Simple fixed-window limiter backed by the shared Django cache."""
    limit = getattr(settings, 'API_RATE_LIMIT', 60)
    window = getattr(settings, 'API_RATE_WINDOW', 60)
    if limit <= 0 or window <= 0:
        return False

    key = 'interpret:%s:%d' % (client_ip(request), int(time.time() // window))
    try:
        current = cache.get(key, 0)
        if current >= limit:
            return True
        cache.set(key, current + 1, window)
    except Exception:
        logger.warning('rate limiter cache is unavailable', exc_info=True)
    return False


@csrf_exempt
@require_GET
def health(request):
    cfg = llm.get_settings()
    return JsonResponse({
        'status': 'ok',
        'llm_configured': llm.is_configured(),
        'llm_provider': llm.provider_name(cfg['base_url']) if cfg['base_url'] else None,
        'llm_model': cfg['model'] or None,
    })


@csrf_exempt
@require_GET
def manifest(request):
    try:
        return JsonResponse(load_manifest())
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
@require_POST
def interpret_metaphor(request):
    """
    Interpret a metaphor or headline and return the library objects to use.

    The LLM only selects existing assets; the response is validated against
    the library whitelist. On any provider failure the local semantic
    fallback takes over so the feature keeps working offline.
    """
    if is_rate_limited(request):
        response = JsonResponse({'error': 'too many requests'}, status=429)
        response['Retry-After'] = str(getattr(settings, 'API_RATE_WINDOW', 60))
        return response

    max_bytes = getattr(settings, 'MAX_REQUEST_BYTES', 64 * 1024)
    if len(request.body) > max_bytes:
        return JsonResponse({'error': 'request body is too large'}, status=413)

    try:
        payload = json.loads(request.body or b'{}')
    except Exception:
        return JsonResponse({'error': 'invalid JSON body'}, status=400)

    text = (payload.get('text') or '').strip()
    if not text:
        return JsonResponse({'error': 'text is required'}, status=400)

    max_chars = getattr(settings, 'MAX_INPUT_CHARS', 1000)
    if len(text) > max_chars:
        return JsonResponse(
            {'error': 'text is too long', 'max_length': max_chars},
            status=413,
        )

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
                # The model is not required to pick a background layer, but
                # the composition looks incomplete without one. Add the same
                # deterministic background the local fallback would use.
                model_background = next(
                    (o for o in objects if o['role'] == 'background'), None
                )
                background_source = 'llm' if model_background else 'none'
                background_asset = model_background['assetId'] if model_background else None
                background_service = 'LLM' if model_background else None

                if not model_background:
                    used = {o['assetId'] for o in objects}
                    background = fallback.pick_background(
                        text,
                        fallback.build_index(variants),
                        used,
                        library.get('defaultBackground'),
                        fallback.build_background_index(variants),
                    )
                    if background:
                        objects.append({
                            'assetId': background,
                            'role': 'background',
                            'reason': 'background matched by local matcher',
                        })
                        background_source = 'local_fallback'
                        background_asset = background
                        background_service = 'fallback.pick_background'

                return JsonResponse({
                    'objects': objects,
                    'source': 'llm',
                    'reason': objects[0].get('reason', ''),
                    'warnings': validation_errors,
                    'llm_info': {
                        'provider': llm.provider_name(cfg['base_url']),
                        'model': cfg['model'],
                        'base_url': llm.display_base_url(cfg['base_url']),
                        'response': raw,
                        'background_source': background_source,
                        'background_asset': background_asset,
                        'background_service': background_service,
                    },
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
