#!/usr/bin/env bash
# Startet das Ideenportal mit Demo-Daten (Docker nötig) und öffnet den Browser. Beenden: docker compose down
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Docker fehlt: https://www.docker.com/products/docker-desktop/"; exit 1; }
docker compose up -d --build
for i in $(seq 1 180); do
  if curl -fs http://localhost:3000/api/health >/dev/null 2>&1; then
    (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) || (command -v open >/dev/null && open http://localhost:3000) || true
    echo "Läuft auf http://localhost:3000 – beenden mit: docker compose down"; exit 0
  fi
  sleep 1
done
echo "Die App antwortet noch nicht – Status: docker compose logs app"
