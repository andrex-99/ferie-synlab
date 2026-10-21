# Demo dell'app: solo Python standard library, nessuna dipendenza da installare.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0

WORKDIR /app

COPY server.py ./
COPY public ./public

# L'utente non privilegiato deve poter scrivere il database e la cartella email.
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data \
    && chown -R app:app /app
USER app

# La porta vera la decide la piattaforma con la variabile PORT.
EXPOSE 8080

CMD ["python3", "server.py", "serve", "--host", "0.0.0.0"]
