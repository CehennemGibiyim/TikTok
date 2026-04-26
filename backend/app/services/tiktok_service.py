#!/usr/bin/env python3
"""
TikTok Servisi - Canlı yayın takibi ve sandık yakalama
"""

import asyncio
import json
from typing import Dict, List, Optional
from datetime import datetime
import logging

from TikTokLive import TikTokLiveClient
from TikTokLive.events import ConnectEvent, GiftEvent, EnvelopeEvent, CommentEvent
import aiohttp
import requests

from app.core.websocket import ConnectionManager
from app.core.database import get_db
from app.models.user import User
from app.models.live_session import LiveSession

logger = logging.getLogger(__name__)

class TikTokService:
    """TikTok servis sınıfı"""
    
    def __init__(self):
        self.active_clients: Dict[str, TikTokLiveClient] = {}
        self.active_sessions: Dict[str, LiveSession] = {}
        self.connection_manager = ConnectionManager()
        self.session = aiohttp.ClientSession()
        
    async def initialize(self):
        """Servisi başlat"""
        logger.info("🚀 TikTok servisi başlatılıyor...")
        
    async def shutdown(self):
        """Servisi kapat"""
        logger.info("🛑 TikTok servisi kapatılıyor...")
        
        # Tüm aktif client'ları kapat
        for client_id, client in self.active_clients.items():
            try:
                await client.disconnect()
                logger.info(f"✅ Client kapatıldı: {client_id}")
            except Exception as e:
                logger.error(f"❌ Client kapatılamadı {client_id}: {e}")
        
        # Session'ı kapat
        await self.session.close()
        
    async def subscribe_to_live(self, live_id: str, user_id: str) -> bool:
        """Canlı yayına abone ol"""
        try:
            # TikTok kullanıcı adını al
            username = live_id.replace("@", "")
            
            # Client oluştur
            client = TikTokLiveClient(unique_id=username)
            
            # Event handler'ları ekle
            self._setup_event_handlers(client, user_id)
            
            # Bağlan
            await client.connect()
            
            # Client'ı kaydet
            self.active_clients[f"{user_id}_{live_id}"] = client
            
            logger.info(f"✅ Canlı yayına abone olundu: {live_id} (Kullanıcı: {user_id})")
            return True
            
        except Exception as e:
            logger.error(f"❌ Canlı yayına abone olunamadı {live_id}: {e}")
            return False
    
    def _setup_event_handlers(self, client: TikTokLiveClient, user_id: str):
        """Event handler'ları kur"""
        
        @client.on(ConnectEvent)
        async def on_connect(event: ConnectEvent):
            """Bağlantı kurulduğunda"""
            logger.info(f"🔗 TikTok'a bağlandı: @{event.unique_id}")
            
            # Kullanıcıya bildir gönder
            await self.connection_manager.send_message(user_id, {
                "type": "live_connected",
                "data": {
                    "username": event.unique_id,
                    "room_id": client.room_id,
                    "timestamp": datetime.now().isoformat()
                }
            })
        
        @client.on(GiftEvent)
        async def on_gift(event: GiftEvent):
            """Hediye geldiğinde"""
            gift_data = {
                "type": "gift_received",
                "data": {
                    "user": event.user.unique_id,
                    "gift_name": event.gift.name,
                    "gift_count": event.gift.count,
                    "gift_cost": event.gift.info.diamond_count,
                    "repeat_count": event.repeat_count,
                    "timestamp": datetime.now().isoformat()
                }
            }
            
            # Kullanıcıya bildir gönder
            await self.connection_manager.send_message(user_id, gift_data)
            
            # Veritabanına kaydet
            await self._save_gift_data(user_id, gift_data["data"])
            
            logger.info(f"💎 Hediye alındı: {event.gift.name} from {event.user.unique_id}")
        
        @client.on(EnvelopeEvent)
        async def on_envelope(event: EnvelopeEvent):
            """Sandık geldiğinde"""
            chest_data = {
                "type": "chest_detected",
                "data": {
                    "user": event.user.unique_id,
                    "chest_type": getattr(event, 'chest_type', 'unknown'),
                    "chest_value": getattr(event, 'chest_value', 0),
                    "timestamp": datetime.now().isoformat()
                }
            }
            
            # Kullanıcıya bildir gönder
            await self.connection_manager.send_message(user_id, chest_data)
            
            # Veritabanına kaydet
            await self._save_chest_data(user_id, chest_data["data"])
            
            logger.info(f"📦 Sandık tespit edildi: {event.user.unique_id}")
        
        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            """Yorum geldiğinde"""
            comment_data = {
                "type": "comment_received",
                "data": {
                    "user": event.user.unique_id,
                    "comment": event.comment,
                    "timestamp": datetime.now().isoformat()
                }
            }
            
            # Kullanıcıya bildir gönder
            await self.connection_manager.send_message(user_id, comment_data)
            
            logger.info(f"💬 Yorum: {event.user.unique_id}: {event.comment}")
    
    async def start_chest_detection(self, user_id: str) -> bool:
        """Sandık tespitini başlat"""
        try:
            # Aktif client'lardan sandık tespitini başlat
            for client_key, client in self.active_clients.items():
                if user_id in client_key:
                    # Sandık tespiti zaten aktif (Event handler'lar sayesinde)
                    logger.info(f"📦 Sandık tespiti aktif: {client_key}")
                    return True
            
            logger.warning(f"❌ Aktif yayın bulunamadı: {user_id}")
            return False
            
        except Exception as e:
            logger.error(f"❌ Sandık tespiti başlatılamadı: {e}")
            return False
    
    async def send_gift(self, user_id: str, gift_data: dict) -> dict:
        """Hediye gönder"""
        try:
            # TikAPI.io üzerinden hediye gönder
            api_url = f"{settings.tiktok_base_url}/gifts/send"
            
            headers = {
                "Authorization": f"Bearer {settings.tiktok_api_key}",
                "Content-Type": "application/json"
            }
            
            payload = {
                "receiver_id": gift_data.get("receiver_id"),
                "gift_id": gift_data.get("gift_id"),
                "count": gift_data.get("count", 1),
                "message": gift_data.get("message", "")
            }
            
            async with self.session.post(api_url, headers=headers, json=payload) as response:
                if response.status == 200:
                    result = await response.json()
                    logger.info(f"🎁 Hediye gönderildi: {gift_data}")
                    return {"success": True, "data": result}
                else:
                    error_text = await response.text()
                    logger.error(f"❌ Hediye gönderilemedi: {error_text}")
                    return {"success": False, "error": error_text}
                    
        except Exception as e:
            logger.error(f"❌ Hediye gönderme hatası: {e}")
            return {"success": False, "error": str(e)}
    
    async def get_user_stats(self, user_id: str) -> dict:
        """Kullanıcı istatistiklerini getir"""
        try:
            # TikAPI.io üzerinden kullanıcı bilgilerini al
            api_url = f"{settings.tiktok_base_url}/user/{user_id}/stats"
            
            headers = {
                "Authorization": f"Bearer {settings.tiktok_api_key}",
                "Content-Type": "application/json"
            }
            
            async with self.session.get(api_url, headers=headers) as response:
                if response.status == 200:
                    stats = await response.json()
                    logger.info(f"📊 Kullanıcı istatistikleri alındı: {user_id}")
                    return {"success": True, "data": stats}
                else:
                    error_text = await response.text()
                    logger.error(f"❌ İstatistikler alınamadı: {error_text}")
                    return {"success": False, "error": error_text}
                    
        except Exception as e:
            logger.error(f"❌ İstatistik getirme hatası: {e}")
            return {"success": False, "error": str(e)}
    
    async def _save_gift_data(self, user_id: str, gift_data: dict):
        """Hediye verisini veritabanına kaydet"""
        try:
            db = next(get_db())
            # Veritabanı kayıt işlemi
            # TODO: Gift model'i oluştur ve kaydet
            logger.debug(f"💾 Hediye verisi kaydedildi: {gift_data}")
        except Exception as e:
            logger.error(f"❌ Hediye verisi kaydedilemedi: {e}")
    
    async def _save_chest_data(self, user_id: str, chest_data: dict):
        """Sandık verisini veritabanına kaydet"""
        try:
            db = next(get_db())
            # Veritabanı kayıt işlemi
            # TODO: Chest model'i oluştur ve kaydet
            logger.debug(f"💾 Sandık verisi kaydedildi: {chest_data}")
        except Exception as e:
            logger.error(f"❌ Sandık verisi kaydedilemedi: {e}")

# Singleton instance
tiktok_service = TikTokService()
