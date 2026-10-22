# Reuses the pinned pr-triage base (Python, FastAPI, uvicorn and git already in it), so this adds no new dependency.
FROM codiumai/pr-agent@sha256:a5741a479f21d20a9bbeca7847a720f92ac6f427e8dc0920fefa039ecafd5e6f

COPY app.py /srv/review-workspaces/app.py
WORKDIR /srv/review-workspaces
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
# Runs as the same uid as the Paperclip agents (1000), so the reviewer can use the worktrees it is pointed at.
USER 1000:1000
EXPOSE 8080
ENTRYPOINT []
CMD ["python", "-m", "uvicorn", "app:app", "--app-dir", "/srv/review-workspaces", "--host", "0.0.0.0", "--port", "8080", "--log-level", "warning"]
