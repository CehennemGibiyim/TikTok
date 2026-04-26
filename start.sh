#!/bin/bash

# TikTok Panel - Hızlı Başlangıç Script (Mac/Linux)

# Renkler
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Başlık
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}    TikTok Panel Hızlı Başlangıç${NC}"
echo -e "${BLUE}========================================${NC}"
echo

# Menü
show_menu() {
    echo -e "${GREEN}[1]${NC} Docker ile Başlat (Tavsiye Edilen)"
    echo -e "${GREEN}[2]${NC} Manuel Başlat"
    echo -e "${GREEN}[3]${NC} Sistemi Durdur"
    echo -e "${GREEN}[4]${NC} Logları Görüntüle"
    echo -e "${GREEN}[5]${NC} Çıkış"
    echo
    read -p "Seçiminizi yapın (1-5): " choice
}

# Docker ile başlat
docker_start() {
    echo
    echo -e "${YELLOW}Docker ile TikTok Panel başlatılıyor...${NC}"
    echo

    # Docker kontrol
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}[HATA] Docker bulunamadı!${NC}"
        echo "Lütfen Docker'ı kurun: https://docs.docker.com/get-docker/"
        read -p "Devam etmek için Enter'a basın..."
        return
    fi

    # Docker Compose kontrol
    if ! command -v docker-compose &> /dev/null; then
        echo -e "${RED}[HATA] Docker Compose bulunamadı!${NC}"
        echo "Lütfen Docker Compose'ı kurun."
        read -p "Devam etmek için Enter'a basın..."
        return
    fi

    echo "Servisler başlatılıyor..."
    docker-compose up -d

    echo
    echo -e "${GREEN}Servisler başlatıldı!${NC}"
    echo
    echo "Erişim Adresleri:"
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:8000"
    echo "  API Docs: http://localhost:8000/api/docs"
    echo
    echo "Logları izlemek için: docker-compose logs -f"
    echo
    read -p "Devam etmek için Enter'a basın..."
}

# Manuel başlat
manual_start() {
    echo
    echo -e "${YELLOW}Manuel başlatma seçildi...${NC}"
    echo

    # Python kontrol
    if ! command -v python3 &> /dev/null; then
        echo -e "${RED}[HATA] Python3 bulunamadı!${NC}"
        echo "Lütfen Python 3.9+ kurun: https://www.python.org/downloads/"
        read -p "Devam etmek için Enter'a basın..."
        return
    fi

    # Node.js kontrol
    if ! command -v node &> /dev/null; then
        echo -e "${RED}[HATA] Node.js bulunamadı!${NC}"
        echo "Lütfen Node.js 16+ kurun: https://nodejs.org/"
        read -p "Devam etmek için Enter'a basın..."
        return
    fi

    echo "Backend başlatılıyor..."
    cd backend

    # Virtual environment kontrol
    if [ ! -d "venv" ]; then
        echo "Virtual environment oluşturuluyor..."
        python3 -m venv venv
    fi

    # Environment'ı aktifleştir
    source venv/bin/activate

    # Dependencies kur
    pip install -r requirements.txt > /dev/null 2>&1

    # .env dosyası kontrol
    if [ ! -f ".env" ]; then
        cp .env.example .env
        echo "Backend .env dosyası oluşturuldu. Lütfen düzenleyin."
        ${EDITOR:-nano} .env
    fi

    # Backend'i arka planda başlat
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 &
    BACKEND_PID=$!

    echo "Frontend başlatılıyor..."
    cd ../frontend

    # Dependencies kontrol
    if [ ! -d "node_modules" ]; then
        echo "Dependencies kuruluyor..."
        npm install > /dev/null 2>&1
    fi

    # .env.local dosyası kontrol
    if [ ! -f ".env.local" ]; then
        cp .env.local.example .env.local
        echo "Frontend .env.local dosyası oluşturuldu. Lütfen düzenleyin."
        ${EDITOR:-nano} .env.local
    fi

    # Frontend'i arka planda başlat
    npm run dev &
    FRONTEND_PID=$!

    echo
    echo -e "${GREEN}Manuel başlatma tamamlandı!${NC}"
    echo
    echo "Erişim Adresleri:"
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:8000"
    echo "  API Docs: http://localhost:8000/api/docs"
    echo
    echo "Servisler arka planda çalışıyor (PID: $BACKEND_PID, $FRONTEND_PID)"
    echo "Durdurmak için 'kill $BACKEND_PID $FRONTEND_PID' komutunu kullanın."
    echo
    read -p "Devam etmek için Enter'a basın..."
}

# Sistemi durdur
stop_system() {
    echo
    echo -e "${YELLOW}Sistem durduruluyor...${NC}"

    # Docker servislerini durdur
    docker-compose down > /dev/null 2>&1

    # Python servislerini durdur
    pkill -f "uvicorn app.main:app" > /dev/null 2>&1

    # Node.js servislerini durdur
    pkill -f "npm run dev" > /dev/null 2>&1
    pkill -f "next dev" > /dev/null 2>&1

    echo
    echo -e "${GREEN}Tüm servisler durduruldu!${NC}"
    echo
    read -p "Devam etmek için Enter'a basın..."
}

# Logları göster
show_logs() {
    echo
    echo -e "${YELLOW}Loglar görüntüleniyor...${NC}
    echo

    echo "Docker logları (son 50 satır):"
    docker-compose logs --tail=50 2>/dev/null || echo "Docker logları bulunamadı."

    echo
    read -p "Devam etmek için Enter'a basın..."
}

# Ana döngü
main_loop() {
    while true; do
        clear
        show_menu
        
        case $choice in
            1)
                docker_start
                ;;
            2)
                manual_start
                ;;
            3)
                stop_system
                ;;
            4)
                show_logs
                ;;
            5)
                echo
                echo -e "${GREEN}TikTok Panel kapatılıyor...${NC}"
                echo
                exit 0
                ;;
            *)
                echo
                echo -e "${RED}[HATA] Geçersiz seçim! Lütfen 1-5 arası bir sayı girin.${NC}"
                echo
                read -p "Devam etmek için Enter'a basın..."
                ;;
        esac
    done
}

# Başlat
main_loop
