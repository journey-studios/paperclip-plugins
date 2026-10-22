# PR-Agent (MIT) behind a tiny authenticated HTTP API. Pinned by digest so a moving `latest` cannot change behaviour.
FROM codiumai/pr-agent@sha256:a5741a479f21d20a9bbeca7847a720f92ac6f427e8dc0920fefa039ecafd5e6f

RUN useradd --system --uid 10001 --create-home --home-dir /home/triage triage
COPY app.py repo_rules.py /srv/pr-triage/
WORKDIR /app
ENV PYTHONPATH=/app:/srv/pr-triage HOME=/home/triage PYTHONDONTWRITEBYTECODE=1
USER triage
EXPOSE 8080
ENTRYPOINT []
CMD ["python", "-m", "uvicorn", "app:app", "--app-dir", "/srv/pr-triage", "--host", "0.0.0.0", "--port", "8080", "--log-level", "warning"]
