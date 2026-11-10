"""
Django settings for core project.
"""

from pathlib import Path
import os

from django.core.exceptions import ImproperlyConfigured


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ('0', 'false', 'no', 'off', '')


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


BASE_DIR = Path(__file__).resolve().parent.parent

DEBUG = env_bool('DJANGO_DEBUG', True)

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', '')
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = 'django-insecure-dev-only-key-change-me'
    else:
        raise ImproperlyConfigured('DJANGO_SECRET_KEY is required when DJANGO_DEBUG is off')

_allowed_hosts = os.environ.get('DJANGO_ALLOWED_HOSTS', '')
if _allowed_hosts:
    ALLOWED_HOSTS = [h.strip() for h in _allowed_hosts.split(',') if h.strip()]
elif DEBUG:
    ALLOWED_HOSTS = ['*']
else:
    ALLOWED_HOSTS = ['localhost', '127.0.0.1']

INSTALLED_APPS = [
    'django.contrib.staticfiles',
    'api',
    'web',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'web' / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATICFILES_DIRS = [BASE_DIR.parent / 'static']
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedStaticFilesStorage'},
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

_csrf_origins = os.environ.get('DJANGO_CSRF_TRUSTED_ORIGINS', '')
CSRF_TRUSTED_ORIGINS = (
    [o.strip() for o in _csrf_origins.split(',') if o.strip()]
    if _csrf_origins
    else ['http://localhost:8000', 'http://127.0.0.1:8000']
)

# Rate limiting uses the shared cache. A file-based cache works across
# gunicorn workers on one host; use Redis behind multiple hosts.
_cache_dir = os.environ.get('DJANGO_CACHE_DIR', '')
if _cache_dir:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.filebased.FileBasedCache',
            'LOCATION': _cache_dir,
        }
    }
else:
    CACHES = {
        'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}
    }

MAX_INPUT_CHARS = env_int('MAX_INPUT_CHARS', 1000)
MAX_REQUEST_BYTES = env_int('MAX_REQUEST_BYTES', 64 * 1024)
API_RATE_LIMIT = env_int('API_RATE_LIMIT', 60)
API_RATE_WINDOW = env_int('API_RATE_WINDOW', 60)
TRUST_PROXY_HEADERS = env_bool('TRUST_PROXY_HEADERS', False)

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT = env_bool('DJANGO_SECURE_SSL_REDIRECT', False)
    SESSION_COOKIE_SECURE = env_bool('DJANGO_SECURE_COOKIES', True)
    CSRF_COOKIE_SECURE = env_bool('DJANGO_SECURE_COOKIES', True)
    SECURE_HSTS_SECONDS = env_int('DJANGO_HSTS_SECONDS', 0)
    SECURE_HSTS_INCLUDE_SUBDOMAINS = SECURE_HSTS_SECONDS > 0
    SECURE_HSTS_PRELOAD = SECURE_HSTS_SECONDS > 0
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = 'DENY'

# LLM proxy (OpenAI-compatible provider). Optional: without these values the
# service falls back to local semantic matching.
LLM_BASE_URL = os.environ.get('LLM_BASE_URL', '')
LLM_MODEL = os.environ.get('LLM_MODEL', '')
LLM_API_KEY = os.environ.get('LLM_API_KEY', '')
LLM_TIMEOUT = os.environ.get('LLM_TIMEOUT', '20')
LLM_MAX_OBJECTS = os.environ.get('LLM_MAX_OBJECTS', '3')

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {'class': 'logging.StreamHandler'},
    },
    'root': {
        'handlers': ['console'],
        'level': os.environ.get('DJANGO_LOG_LEVEL', 'INFO'),
    },
}
