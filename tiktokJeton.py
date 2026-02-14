import sys
import time
import threading
import uiautomator2 as u2
import pytesseract
import re
import winsound
import csv
import os
import requests
from datetime import datetime
from PyQt6.QtWidgets import (QApplication, QMainWindow, QTableWidget, 
                             QTableWidgetItem, QVBoxLayout, QWidget, 
                             QLabel, QHeaderView, QHBoxLayout, QFrame, QTextEdit)
from PyQt6.QtCore import QTimer, Qt, pyqtSignal, QObject
from PyQt6.QtGui import QFont, QColor

# Tesseract yolu
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

class DataSignals(QObject):
    update_data = pyqtSignal(list)
    update_stats = pyqtSignal(dict)
    log_message = pyqtSignal(str)
    connection_status = pyqtSignal(bool) # Bağlantı durumu sinyali

signals = DataSignals()

# --- AYARLAR ---
WA_PHONE = "905XXXXXXXXX" 
WA_API_KEY = "123456"

class HazineMotoru:
    def __init__(self):
        self.hazineler = {}
        self.is_running = True
        self.device = None
        self.stats = {"toplam_deneme": 0, "basarili": 0, "basarisiz": 0}

    def whatsapp_gonder(self, mesaj):
        try:
            url = f"https://api.callmebot.com/whatsapp.php?phone={WA_PHONE}&text={mesaj}&apikey={WA_API_KEY}"
            threading.Thread(target=lambda: requests.get(url)).start()
        except: pass

    def log(self, msg):
        now = datetime.now().strftime("%H:%M:%S")
        signals.log_message.emit(f"[{now}] {msg}")

    def cihaz_baglan(self):
        """Cihazı bulana kadar döngüde kalır."""
        while self.is_running:
            try:
                self.log("📡 Android cihaz aranıyor...")
                self.device = u2.connect() # Gerekirse IP yaz: u2.connect("127.0.0.1:5555")
                info = self.device.info
                self.log(f"✅ Bağlantı Kuruldu: {info.get('modelName', 'Android Device')}")
                signals.connection_status.emit(True)
                return True
            except Exception:
                self.log("❌ Cihaz Bulunamadı! 10 saniye sonra tekrar denenecek...")
                signals.connection_status.emit(False)
                time.sleep(10)
        return False

    def cihaz_taramasi(self):
        if not self.cihaz_baglan(): return

        d = self.device
        d.app_start("com.zhiliaoapp.musically")
        self.whatsapp_gonder("🚀 *Alpha Radar Aktif!* Cihaz bağlantısı sağlandı.")
        
        while self.is_running:
            try:
                img = d.screenshot()
                text = pytesseract.image_to_string(img, config='--psm 11')
                user_el = d(resourceId="com.zhiliaoapp.musically:id/user_name_text")
                nick = user_el.get_text() if user_el.exists else "Bilinmeyen"

                match = re.search(r'\d{2}:\d{2}', text)
                
                if match:
                    m, s = map(int, match.group().split(':'))
                    kalan = (m * 60) + s
                    self.hazineler[nick] = {"bitis": time.time() + kalan}

                    if kalan <= 3:
                        self.log(f"🎯 Hedef Alınıyor: @{nick}")
                        self.stats["toplam_deneme"] += 1
                        d.click(0.15, 0.22) 
                        time.sleep(0.5)
                        d.click(0.50, 0.55) 
                        self.stats["basarili"] += 1
                        self.whatsapp_gonder(f"✅ *Hazine Alındı!* @{nick}")
                        time.sleep(2)
                        d.press("back")
                        d.swipe(0.5, 0.8, 0.5, 0.2)
                
                sirali = sorted(self.hazineler.items(), key=lambda x: x[1]['bitis'])
                self.hazineler = {k: v for k, v in self.hazineler.items() if v['bitis'] > time.time()}
                
                signals.update_data.emit(sirali)
                signals.update_stats.emit(self.stats)
                
                if not match:
                    d.swipe(0.5, 0.8, 0.5, 0.2)
                    time.sleep(2)
                else:
                    time.sleep(1)

            except Exception as e:
                self.log(f"⚠️ Bağlantı Hatası: {e}")
                signals.connection_status.emit(False)
                if not self.cihaz_baglan(): break # Tekrar bağlanmaya çalış

class AlphaFinalPanel(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("ALPHA COMMAND CENTER v7.0")
        self.resize(1100, 850)
        
        self.setStyleSheet("""
            QMainWindow { background: #020205; }
            QTableWidget { background-color: #0a0a15; color: white; border: 1px solid #1a1a3a; }
            QHeaderView::section { background-color: #0d0d1a; color: #39ff14; }
            QTextEdit { background-color: #000; color: #00FF41; font-family: 'Consolas'; border: 1px solid #1a1a3a; }
        """)

        layout = QVBoxLayout()
        central = QWidget()
        central.setLayout(layout)
        self.setCentralWidget(central)

        # Üst Bar (Logo ve Bağlantı Durumu)
        header = QHBoxLayout()
        self.title = QLabel("🌀 ALPHA RADAR | SİSTEM KOMUTA")
        self.title.setStyleSheet("color: #39ff14; font-size: 20px; font-weight: bold;")
        header.addWidget(self.title)

        self.conn_label = QLabel("● BAĞLANTI YOK")
        self.conn_label.setStyleSheet("color: #ff3131; font-weight: bold; font-size: 14px;")
        header.addStretch()
        header.addWidget(self.conn_label)
        layout.addLayout(header)

        # İstatistikler
        stats_layout = QHBoxLayout()
        self.v1 = self.create_stat_box(stats_layout, "DENEME", "#00d2ff")
        self.v2 = self.create_stat_box(stats_layout, "HASILAT", "#39ff14")
        layout.addLayout(stats_layout)

        # Tablo ve Log
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["SİMGE", "YAYINCI", "DURUM", "SAYAÇ"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table)

        self.log_area = QTextEdit()
        self.log_area.setFixedHeight(150)
        self.log_area.setReadOnly(True)
        layout.addWidget(self.log_area)

        # Sinyal Bağlantıları
        signals.update_data.connect(self.tablo_guncelle)
        signals.update_stats.connect(self.stats_guncelle)
        signals.log_message.connect(lambda m: self.log_area.append(m))
        signals.connection_status.connect(self.update_connection_ui)

    def create_stat_box(self, layout, title, color):
        f = QFrame()
        f.setStyleSheet(f"border: 1px solid {color}; border-radius: 10px; background: #080812;")
        l = QVBoxLayout(f)
        t_l = QLabel(title)
        t_l.setStyleSheet(f"color: {color}; font-size: 10px;")
        v_l = QLabel("0")
        v_l.setStyleSheet("color: white; font-size: 24px; font-weight: bold;")
        v_l.setAlignment(Qt.AlignmentFlag.AlignCenter)
        l.addWidget(t_l); l.addWidget(v_l)
        layout.addWidget(f)
        return v_l

    def update_connection_ui(self, connected):
        if connected:
            self.conn_label.setText("● CİHAZ BAĞLI")
            self.conn_label.setStyleSheet("color: #39ff14; font-weight: bold;")
        else:
            self.conn_label.setText("● BAĞLANTI KESİLDİ")
            self.conn_label.setStyleSheet("color: #ff3131; font-weight: bold;")

    def stats_guncelle(self, s):
        self.v1.setText(str(s['toplam_deneme']))
        self.v2.setText(str(s['basarili']))

    def tablo_guncelle(self, data):
        self.table.setRowCount(len(data))
        for i, (user, info) in enumerate(data):
            kalan = int(info['bitis'] - time.time())
            icon = "🌀" if kalan < 15 else "📦"
            self.table.setItem(i, 0, QTableWidgetItem(f"  {icon}"))
            self.table.setItem(i, 1, QTableWidgetItem(f"@{user.upper()}"))
            st_item = QTableWidgetItem("KRİTİK" if kalan < 15 else "İZLENİYOR")
            st_item.setForeground(QColor("#FF3131" if kalan < 15 else "#FFD700"))
            self.table.setItem(i, 2, st_item)
            self.table.setItem(i, 3, QTableWidgetItem(f"{kalan}s"))

if __name__ == "__main__":
    app = QApplication(sys.argv)
    panel = AlphaFinalPanel()
    motor = HazineMotoru()
    threading.Thread(target=motor.cihaz_taramasi, daemon=True).start()
    panel.show()
    sys.exit(app.exec())
