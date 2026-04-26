@echo off
title TikTok Panel - Hızlı Başlangıç
color 0A

echo.
echo  ========================================
echo     TikTok Panel Hızlı Başlangıç
echo  ========================================
echo.

echo [1] Docker ile Başlat (Tavsiye Edilen)
echo [2] Manuel Başlat
echo [3] Sistemi Durdur
echo [4] Logları Görüntüle
echo [5] Çıkış
echo.

set /p choice="Seçiminizi yapın (1-5): "

if "%choice%"=="1" goto docker_start
if "%choice%"=="2" goto manual_start
if "%choice%"=="3" goto stop_system
if "%choice%"=="4" goto show_logs
if "%choice%"=="5" goto exit
goto invalid_choice

:docker_start
echo.
echo Docker ile TikTok Panel başlatılıyor...
echo.

echo Docker Desktop kontrol ediliyor...
docker --version >nul 2>&1
if errorlevel 1 (
    echo [HATA] Docker Desktop bulunamadı!
    echo Lütfen Docker Desktop'ı kurun: https://www.docker.com/products/docker-desktop
    pause
    goto start
)

echo Servisler başlatılıyor...
docker-compose up -d

echo.
echo Servisler başlatıldı!
echo.
echo Erişim Adresleri:
echo   Frontend: http://localhost:3000
echo   Backend:  http://localhost:8000
echo   API Docs: http://localhost:8000/api/docs
echo.
echo Logları izlemek için: docker-compose logs -f
echo.
pause
goto start

:manual_start
echo.
echo Manuel başlatma seçildi...
echo.

echo Python kontrol ediliyor...
python --version >nul 2>&1
if errorlevel 1 (
    echo [HATA] Python bulunamadı!
    echo Lütfen Python 3.9+ kurun: https://www.python.org/downloads/
    pause
    goto start
)

echo Node.js kontrol ediliyor...
node --version >nul 2>&1
if errorlevel 1 (
    echo [HATA] Node.js bulunamadı!
    echo Lütfen Node.js 16+ kurun: https://nodejs.org/
    pause
    goto start
)

echo Backend başlatılıyor...
cd backend
if not exist "venv" (
    echo Virtual environment oluşturuluyor...
    python -m venv venv
)

call venv\Scripts\activate
pip install -r requirements.txt >nul 2>&1

if not exist ".env" (
    copy .env.example .env >nul
    echo Backend .env dosyası oluşturuldu. Lütfen düzenleyin.
    notepad .env
)

start "TikTok Panel Backend" cmd /k "uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

echo Frontend başlatılıyor...
cd ..\frontend
if not exist "node_modules" (
    echo Dependencies kuruluyor...
    npm install >nul 2>&1
)

if not exist ".env.local" (
    copy .env.local.example .env.local >nul
    echo Frontend .env.local dosyası oluşturuldu. Lütfen düzenleyin.
    notepad .env.local
)

start "TikTok Panel Frontend" cmd /k "npm run dev"

echo.
echo Manuel başlatma tamamlandı!
echo.
echo Erişim Adresleri:
echo   Frontend: http://localhost:3000
echo   Backend:  http://localhost:8000
echo   API Docs: http://localhost:8000/api/docs
echo.
echo Servisler ayrı pencerelerde çalışıyor.
echo.
pause
goto start

:stop_system
echo.
echo Sistem durduruluyor...

echo Docker servisleri durduruluyor...
docker-compose down >nul 2>&1

echo Python servisleri durduruluyor...
taskkill /f /im python.exe >nul 2>&1

echo Node.js servisleri durduruluyor...
taskkill /f /im node.exe >nul 2>&1

echo.
echo Tüm servisler durduruldu!
echo.
pause
goto start

:show_logs
echo.
echo Loglar görüntüleniyor...

echo Docker logları:
docker-compose logs --tail=50

echo.
echo Devam etmek için Enter'a basın...
pause
goto start

:invalid_choice
echo.
echo [HATA] Geçersiz seçim! Lütfen 1-5 arası bir sayı girin.
echo.
pause
goto start

:exit
echo.
echo TikTok Panel kapatılıyor...
echo.
exit /b 0
