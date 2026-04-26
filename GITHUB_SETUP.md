# 🚀 GitHub Kurulum Rehberi

## 📋 Gerekli GitHub Ayarları

### 🔐 Secrets (Repository Settings > Secrets and variables > Actions)

Aşağıdaki secrets'ı GitHub repository'nize ekleyin:

```bash
# Railway API Token
RAILWAY_TOKEN=your_railway_api_token

# Railway Project ID
RAILWAY_PROJECT_ID=your_railway_project_id

# Railway Service ID
RAILWAY_SERVICE_ID=your_railway_service_id

# Production API URL
API_URL=https://your-app.railway.app

# Production WebSocket URL
WS_URL=wss://your-app.railway.app

# Backend Secret Key
SECRET_KEY=your-super-secret-key-change-in-production
```

### 🔧 Railway Kurulum

1. **Railway Hesabı Oluştur:**
   - [railway.app](https://railway.app) sitesine gidin
   - Ücretsiz hesap oluşturun

2. **Proje Oluştur:**
   - "New Project" > "Deploy from GitHub repository"
   - GitHub repository'nizi seçin
   - Python template'ı seçin

3. **Environment Variables:**
   - Railway dashboard'da "Variables" sekmesine gidin
   - Aşağıdaki değişkenleri ekleyin:
   ```bash
   DATABASE_URL=${{ postgres.DATABASE_URL }}
   REDIS_URL=${{ redis.REDIS_URL }}
   SECRET_KEY=${{ secrets.SECRET_KEY }}
   DEBUG=false
   CORS_ORIGINS=["https://tiktokpanel.pages.dev", "https://yourusername.github.io"]
   ```

4. **Service ID'leri Al:**
   - Railway dashboard'da service ID'yi kopyalayın
   - GitHub secrets'a ekleyin

### 🌐 GitHub Pages Ayarları

1. **GitHub Pages Aktifleştir:**
   - Repository settings > Pages
   - Source: "GitHub Actions"

2. **Custom Domain (İsteğe Bağlı):**
   - Repository settings > Pages > Custom domain
   - Domain'inizi ekleyin

### 🔄 GitHub Workflows

Otomatik olarak çalışacak workflow'lar:

#### **🚀 Main Deployment (`deploy.yml`)**
- `main` branch'ine push'landığında çalışır
- Frontend'i GitHub Pages'e deploy eder
- Backend'i Railway'e deploy eder
- Health checks yapar

#### **🧪 CI Pipeline (`ci.yml`)**
- Her push ve pull request'te çalışır
- Backend ve frontend testleri
- Security taraması
- Docker build testleri
- Integration testleri

#### **🎨 Preview Deployment (`preview.yml`)**
- Pull request oluşturulduğunda çalışır
- Geçici preview environment oluşturur
- PR'a preview link'leri ekler
- PR kapatıldığında temizler

---

## 🎯 Kurulum Adımları

### 1. Repository Oluştur
```bash
# GitHub'da yeni repository oluştur
# İsim: TikTokPanel
# Public seç
# README.md ekle (varsa)
```

### 2. Secrets Ekle
```bash
# GitHub repository > Settings > Secrets and variables > Actions
# Yukarıdaki secrets'ları ekle
```

### 3. Railway Projesi Kur
```bash
# Railway.app'e git
# GitHub repository'sini bağla
# Environment variables'ı ekle
# Service ID'leri al
```

### 4. İlk Deploy
```bash
# Main branch'e push yap
git add .
git commit -m "🚀 Initial deployment setup"
git push origin main

# GitHub Actions otomatik çalışacak
# Railway deploy olacak
# GitHub Pages publish edilecek
```

---

## 🔍 Kontrol Listesi

### ✅ GitHub Ayarları
- [ ] Repository oluşturuldu
- [ ] GitHub Pages aktifleştirildi
- [ ] Secrets eklendi
- [ ] Workflow'lar eklendi

### ✅ Railway Ayarları
- [ ] Railway projesi oluşturuldu
- [ ] GitHub bağlantısı yapıldı
- [ ] Environment variables eklendi
- [ ] Service ID'leri alındı

### ✅ Test
- [ ] İlk deploy başarılı
- [ ] Frontend erişilebilir
- [ ] Backend çalışıyor
- [ ] WebSocket bağlantısı var
- [ ] API docs erişilebilir

---

## 🌐 Erişim Linkleri

Deploy tamamlandıktan sonra:

### **Frontend (GitHub Pages)**
```
https://yourusername.github.io/TikTokPanel
```

### **Backend (Railway)**
```
https://your-app.railway.app
```

### **API Documentation**
```
https://your-app.railway.app/api/docs
```

### **Health Check**
```
https://your-app.railway.app/api/health
```

---

## 🔄 Otomatik Süreç

### **Push to Main:**
1. Code değişiklikleri
2. GitHub Actions başlar
3. Frontend GitHub Pages'e deploy edilir
4. Backend Railway'e deploy edilir
5. Health checks çalışır
6. Deployment tamamlanır

### **Pull Request:**
1. PR oluşturulur
2. Preview environment oluşturulur
3. PR'ya preview link'leri eklenir
4. Testler çalışır
5. PR merge edilirse main deploy edilir
6. PR kapatılırsa preview temizlenir

---

## 🐛 Troubleshooting

### **Deploy Hataları:**
```bash
# GitHub Actions log'larını kontrol et
# Repository > Actions > Workflow runs

# Railway log'larını kontrol et
# Railway dashboard > Service > Logs
```

### **Secret Hataları:**
```bash
# Secrets'ın doğru eklendiğini kontrol et
# Railway token'ın geçerli olduğunu kontrol et
# Service ID'lerin doğru olduğunu kontrol et
```

### **CORS Hataları:**
```bash
# Railway environment variables'ında CORS_ORIGINS kontrol et
# GitHub Pages URL'sinin eklendiğini kontrol et
```

### **WebSocket Hataları:**
```bash
# WS_URL'nin doğru olduğunu kontrol et
# HTTPS kullanıldığından emin ol
# Railway firewall ayarlarını kontrol et
```

---

## 🎉 Başarı Kontrolü

Deploy başarılı olduysa:

### **✅ Frontend Test:**
```bash
# Browser'da aç
https://yourusername.github.io/TikTokPanel

# Kontrol et:
# - Sayfa yükleniyor
# - WebSocket bağlantısı kuruluyor
# - API status gösteriliyor
# - Demo verileri geliyor
```

### **✅ Backend Test:**
```bash
# API health check
curl https://your-app.railway.app/api/health

# WebSocket test
wscat -c wss://your-app.railway.app/ws/test-user
```

### **✅ Integration Test:**
```bash
# Frontend'den backend'e erişim
# WebSocket bağlantısı
# Real-time veri akışı
# API endpoint'ler
```

---

## 📞 Destek

Sorun yaşarsanız:

1. **GitHub Actions Log'larını kontrol et**
2. **Railway dashboard'u kontrol et**
3. **Bu rehberi tekrar oku**
4. **GitHub Issues aç**

---

**🚀 TikTok Panel artık GitHub'da otomatik çalışıyor!**
