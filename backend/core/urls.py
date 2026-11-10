from django.contrib.staticfiles.views import serve as serve_static
from django.urls import path, include, re_path
from django.conf import settings

urlpatterns = [
    path('api/', include('api.urls')),
    path('', include('web.urls')),
]

# One container serves both the API and the built frontend, so static files
# are registered explicitly. insecure=True makes this work with
# DJANGO_DEBUG=False as well: Django's own static() helper returns an empty
# list outside debug mode, which would silently blank the UI while the
# healthcheck still reports the service as healthy.
if settings.STATIC_URL:
    urlpatterns += [
        re_path(
            r'^%s(?P<path>.*)$' % settings.STATIC_URL.lstrip('/'),
            serve_static,
            {'insecure': True},
        ),
    ]
