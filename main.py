import asyncio
from core.logger import DataBridge
from core.safety import SafetyGuard
from core.collector import ChestCollector

async def main():
    db = DataBridge()
    safety = SafetyGuard()
    collector = ChestCollector(db, safety)
    
    print("🚀 Operasyon Başladı. Hedefler taranıyor...")
    
    while True:
        # Örnek Hedef (Normalde bu veri Scanner'dan gelir)
        target = {
            'streamer': 'TR_Live_1', 
            'type': 'chest', 
            'coins': 20, 
            'link': 'https://www.tiktok.com/live', 
            'time_left': 5
        }
        
        # Tek botla deneme başlat
        await collector.operate("Bot_Hesap_1", target)
        
        # Döngü arası bekleme
        await asyncio.sleep(20)

if __name__ == "__main__":
    asyncio.run(main())
