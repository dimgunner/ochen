FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_DEBUG=0 \
    DJANGO_CACHE_DIR=/tmp/ochen-cache

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app

RUN DJANGO_SECRET_KEY=build-only DJANGO_DEBUG=0 \
    python backend/manage.py collectstatic --noinput

WORKDIR /app/backend

RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app

USER app

EXPOSE 8000

CMD ["sh", "-c", "exec gunicorn core.wsgi:application --bind 0.0.0.0:8000 --workers ${GUNICORN_WORKERS:-3} --timeout ${GUNICORN_TIMEOUT:-60} --access-logfile - --error-logfile -"]
