@echo off
chcp 65001 >nul
title TikTok Sandik Radari - Kurulum ve Baslatma
color 0E
cd /d "%~dp0"

echo ==========================================
echo       TIKTOK RADAR PRO MASAUSTU
echo ==========================================
echo Ilk kez aciyorsaniz bu islem 2-3 dakika surebilir.
echo Paketler (Electron, Puppeteer vb.) indiriliyor...
echo.

call npm install

IF NOT EXIST "node_modules\electron" (
  echo.
  echo [HATA] Moduller kurulamadi! Lutfen bilgisayarinizda Node.js kurulu oldugundan emin olun.
  pause
  exit
)

:: Mobile Bot bağımlılıklarını kontrol et
echo.
echo [INFO] Mobile Bot paketleri kontrol ediliyor...
IF NOT EXIST "node_modules\puppeteer-extra" (
  echo [INFO] Puppeteer Extra yukleniyor...
  call npm install puppeteer-extra puppeteer-extra-plugin-stealth
)

cls
echo ==========================================
echo       TIKTOK RADAR PRO - V2.1
echo       (Mobile Bot + Klasik Sistem)
echo ==========================================
echo.
echo [BILGI] Yeni: Puppeteer Mobile Bot sistemi aktif!
echo [BILGI] Mobil cihaz emulasyonu ile sandik toplama.
echo.
echo Masaustu uygulamasi aciliyor...
echo Arkadaki komut penceresini KAPATMAYIN! (Botlarin calismasi icin acik kalmalidir)
echo.
echo [INFO] Electron baslatiliyor...
"%~dp0node_modules\.bin\electron.cmd" . --enable-logging
pause
