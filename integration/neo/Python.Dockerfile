ARG NEO_NODE_IMAGE=footprint-iac/neo-node:local
FROM ${NEO_NODE_IMAGE} AS node-package
FROM python:3.11-slim-bookworm
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY py-tools/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 neo
COPY py-tools/ /app/py-tools/
# The sidecar imports published coverage/period wire metadata from the actual
# agentfootprint package. Reuse the exact lockfile-installed Node image asset.
COPY --from=node-package /app/node_modules/agentfootprint/canonical-notes.json /app/node_modules/agentfootprint/canonical-notes.json
COPY .iac/start-sidecar.py /app/start-sidecar.py
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=4s --start-period=90s --retries=4 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3)"]
ENTRYPOINT ["python", "/app/start-sidecar.py"]
