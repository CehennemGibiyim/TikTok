# 🚀 TikTok Panel - Çalıştırma Talimatları

## 📋 Gereksinimler

### Sistem Gereksinimleri
- **RAM:** Minimum 4GB (8GB tavsiye edilir)
- **İşlemci:** Modern CPU (Multi-core tavsiye edilir)
- **Depolama:** Minimum 10GB boş alan
- **İnternet:** Stabil bağlantı (TikTok API için)

### Yazılım Gereksinimleri
- **Docker Desktop** (Tavsiye edilen)
- **Python 3.9+** (Manuel kurulum için)
- **Node.js 16+** (Manuel kurulum için)
- **PostgreSQL 13+** (Manuel kurulum için)
- **Redis 6+** (Manuel kurulum için)

---

## 🐳 Yöntem 1: Docker ile Çalıştırma (Tavsiye Edilen)

### Adım 1: Docker Desktop'ı Kur
```bash
# Windows: Docker Desktop for Windows
# Mac: Docker Desktop for Mac
# Linux: Docker Engine + Docker Compose
```

### Adım 2: Projeyi Klonla
```bash
git clone https://github.com/KULLANICI/TikTokPanel.git
cd TikTokPanel
```

### Adım 3: Environment Dosyalarını Hazırla
```bash
# Backend environment
cp backend/.env.example backend/.env

# Frontend environment  
cp frontend/.env.local.example frontend/.env.local
```

### Adım 4: Docker Compose ile Başlat
```bash
# Tüm servisleri başlat
docker-compose up -d

# Logları izle
docker-compose logs -f

# Servisleri durdur
docker-compose down
```

### Adım 5: Erişim
- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:8000
- **API Docs:** http://localhost:8000/api/docs
- **PostgreSQL:** localhost:5432
- **Redis:** localhost:6379

---

## 💻 Yöntem 2: Manuel Kurulum

### Adım 1: Veritabanı Kurulumu

#### PostgreSQL
```bash
# Windows
choco install postgresql

# Mac
brew install postgresql

# Linux (Ubuntu/Debian)
sudo apt-get install postgresql postgresql-contrib

# Servisi başlat
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

#### Redis
```bash
# Windows
choco install redis-64

# Mac
brew install redis

# Linux (Ubuntu/Debian)
sudo apt-get install redis-server

# Servisi başlat
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

### Adım 2: Veritabanı Oluşturma
```bash
# PostgreSQL'e bağlan
sudo -u postgres psql

# Veritabanı ve kullanıcı oluştur
CREATE DATABASE tiktok_panel;
CREATE USER tiktok_user WITH PASSWORD 'tiktok_password';
GRANT ALL PRIVILEGES ON DATABASE tiktok_panel TO tiktok_user;
\q
```

### Adım 3: Backend Kurulumu
```bash
# Backend dizinine gir
cd backend

# Python virtual environment oluştur
python -m venv venv

# Environment'ı aktifleştir
# Windows
venv\Scripts\activate
# Mac/Linux
source venv/bin/activate

# Dependencies kur
pip install -r requirements.txt

# Environment dosyası oluştur
cp .env.example .env

# .env dosyasını düzenle (notepad/vscode)
notepad .env
```

### Adım 4: Frontend Kurulumu
```bash
# Frontend dizinine gir
cd ../frontend

# Dependencies kur
npm install

# Environment dosyası oluştur
cp .env.local.example .env.local

# .env.local dosyasını düzenle
notepad .env.local
```

### Adım 5: Servisleri Başlatma

#### Backend
```bash
# Backend dizininde
cd backend

# Environment aktif
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Mac/Linux

# Başlat
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

#### Frontend (Yeni Terminal)
```bash
# Frontend dizininde
cd frontend

# Başlat
npm run dev
```

---

## 🔧 Konfigürasyon Ayarları

### Backend (.env)
```bash
# Veritabanı
DATABASE_URL=postgresql://tiktok_user:tiktok_password@localhost:5432/tiktok_panel
REDIS_URL=redis://localhost:6379

# Güvenlik
SECRET_KEY=your-super-secret-key-change-in-production

# TikTok API
TIKTOK_API_KEY=your-tiktok-api-key-optional
```

### Frontend (.env.local)
```bash
# API URL'leri
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000
```

---

## 🧪 Test İşlemleri

### Backend Test
```bash
# API health check
curl http://localhost:8000/api/health

# Swagger docs
http://localhost:8000/api/docs
```

### Frontend Test
```bash
# Browser'da aç
http://localhost:3000

# WebSocket bağlantısı kontrol et
# Browser console'da WebSocket bağlantısı kurulmalı
```

---

## 🐛 Sorun Giderme

### Docker Sorunları

#### Port Çakışması
```bash
# Portları kontrol et
netstat -ano | findstr :8000
netstat -ano | findstr :3000

# Port'u kapat
taskkill /PID <PID> /F
```

#### Docker Hataları
```bash
# Cache temizle
docker system prune -a

# Container'ları yeniden oluştur
docker-compose down -v
docker-compose up -d --build
```

### Manuel Kurulum Sorunları

#### Python Hataları
```bash
# Python version kontrol
python --version

# Pip güncelle
pip install --upgrade pip

# Virtual environment yeniden oluştur
rm -rf venv
python -m venv venv
```

#### Node.js Hataları
```bash
# Node version kontrol
node --version
npm --version

# Cache temizle
npm cache clean --force

# Node modules yeniden kur
rm -rf node_modules package-lock.json
npm install
```

#### Veritabanı Hataları
```bash
# PostgreSQL servisi kontrol
sudo systemctl status postgresql

# Bağlantı test
psql -h localhost -U tiktok_user -d tiktok_panel

# Redis servisi kontrol
sudo systemctl status redis-server
redis-cli ping
```

### API Bağlantı Hataları

#### CORS Hatası
```bash
# Backend .env dosyasında CORS ayarlarını kontrol et
CORS_ORIGINS=["http://localhost:3000", "http://127.0.0.1:3000"]
```

#### WebSocket Hatası
```bash
# Frontend .env.local'da WebSocket URL kontrol et
NEXT_PUBLIC_WS_URL=ws://localhost:8000
```

---

## 📱 Production Dağıtımı

### Railway (Backend)
```bash
# Railway CLI kur
npm install -g @railway/cli

# Giriş yap
railway login

# Proje oluştur
railway init

# Deploy et
railway up
```

### Vercel (Frontend)
```bash
# Vercel CLI kur
npm install -g vercel

# Giriş yap
vercel login

# Deploy et
vercel --prod
```

### Supabase (Veritabanı)
```bash
# Supabase projesi oluştur
# PostgreSQL bağlantı URL'sini al
# .env dosyasında güncelle
```

---

## 🔍 Monitoring ve Loglar

### Docker Logları
```bash
# Tüm loglar
docker-compose logs

# Spesifik servis logları
docker-compose logs backend
docker-compose logs frontend
docker-compose logs postgres
docker-compose logs redis

# Real-time log
docker-compose logs -f
```

### Manuel Loglar
```bash
# Backend logları
tail -f backend/logs/tiktok_panel.log

# Frontend logları
# Browser DevTools Console
```

---

## 🚀 Hızlı Başlangıç Script

### Windows (.bat)
```batch
@echo off
echo TikTok Panel Başlatılıyor...

cd backend
call venv\Scripts\activate
start "Backend" cmd /k "uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

cd ../frontend
start "Frontend" cmd /k "npm run dev"

echo Servisler başlatıldı!
echo Backend: http://localhost:8000
echo Frontend: http://localhost:3000
pause
```

### Mac/Linux (.sh)
```bash
#!/bin/bash
echo "TikTok Panel Başlatılıyor..."

cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

cd ../frontend
npm run dev &
FRONTEND_PID=$!

echo "Servisler başlatıldı!"
echo "Backend: http://localhost:8000"
echo "Frontend: http://localhost:3000"

wait $BACKEND_PID $FRONTEND_PID
```

---

## 🎯 Başarı Kontrolü

### Checkliste
- [ ] Docker Desktop çalışıyor
- [ ] PostgreSQL bağlantısı başarılı
- [ ] Redis bağlantısı başarılı
- [ ] Backend API çalışıyor (http://localhost:8000)
- [ ] Frontend çalışıyor (http://localhost:3000)
- [ ] WebSocket bağlantısı kuruldu
- [ ] API docs erişilebilir (http://localhost:8000/api/docs)

### Test URL'leri
```bash
# Health check
curl http://localhost:8000/api/health

# API test
curl http://localhost:8000/

# Frontend test
http://localhost:3000
```

---

## 🆘 Yardım ve Destek

### Logları Paylaş
Sorun yaşarsanız, logları paylaşarak yardım isteyebilirsiniz:

```bash
# Docker logları
docker-compose logs > docker-logs.txt

# Sistem bilgileri
systeminfo > system-info.txt  # Windows
uname -a > system-info.txt     # Mac/Linux
```

### İletişim
- **GitHub Issues:** [Proje Linki]/issues
- **Discord:** [Discord Sunucusu]
- **E-posta:** support@tiktokpanel.com

---

**🎉 Başarılı kurulum! TikTok Panel kullanıma hazır!**
