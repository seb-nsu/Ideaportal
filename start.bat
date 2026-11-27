@echo off
REM Startet das Ideenportal mit Demo-Daten (Docker Desktop noetig) und oeffnet den Browser.
REM Auf der Startseite "Demo ansehen" waehlen und eine Rolle aussuchen. Beenden: docker compose down
cd /d "%~dp0"
where docker >nul 2>nul || (
  echo Docker Desktop fehlt: https://www.docker.com/products/docker-desktop/  ^(installieren, starten, dann erneut doppelklicken^)
  pause
  exit /b 1
)
docker info >nul 2>nul || (
  echo Docker Desktop laeuft nicht - bitte starten und erneut doppelklicken.
  pause
  exit /b 1
)
echo Starte das Ideenportal (beim ersten Mal dauert der Bau einige Minuten) ...
docker compose up -d --build || (pause & exit /b 1)
powershell -NoProfile -Command "for($i=0;$i -lt 180;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:3000/api/health | Out-Null; Start-Process http://localhost:3000; exit 0}catch{Start-Sleep 1}}; exit 1" || echo Die App antwortet noch nicht - Status: docker compose logs app
echo Laeuft auf http://localhost:3000 . Beenden mit: docker compose down
pause
