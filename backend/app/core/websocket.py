#!/usr/bin/env python3
"""
WebSocket Connection Manager - Real-time bağlantı yönetimi
"""

from fastapi import WebSocket, WebSocketDisconnect
from typing import Dict, List, Set
import json
import asyncio
import logging

logger = logging.getLogger(__name__)

class ConnectionManager:
    """WebSocket bağlantı yöneticisi"""
    
    def __init__(self):
        # user_id -> List[WebSocket]
        self.active_connections: Dict[str, List[WebSocket]] = {}
        # WebSocket -> user_id
        self.connection_to_user: Dict[WebSocket, str] = {}
        # Aktif kullanıcılar
        self.active_users: Set[str] = set()
        
    async def connect(self, websocket: WebSocket, user_id: str):
        """Yeni bağlantı kabul et"""
        await websocket.accept()
        
        # Bağlantıyı ekle
        if user_id not in self.active_connections:
            self.active_connections[user_id] = []
        
        self.active_connections[user_id].append(websocket)
        self.connection_to_user[websocket] = user_id
        self.active_users.add(user_id)
        
        logger.info(f"🔗 WebSocket bağlantısı kuruldu: {user_id}")
        
        # Bağlantı başarılı mesajı gönder
        await websocket.send_text(json.dumps({
            "type": "connection_established",
            "data": {
                "user_id": user_id,
                "timestamp": "now",
                "active_users": len(self.active_users)
            }
        }))
        
    def disconnect(self, websocket: WebSocket, user_id: str):
        """Bağlantıyı kes"""
        try:
            # Bağlantıyı kaldır
            if user_id in self.active_connections:
                self.active_connections[user_id].remove(websocket)
                
                # Eğer kullanıcının başka bağlantısı yoksa
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
                    self.active_users.discard(user_id)
            
            # WebSocket mapping'den kaldır
            if websocket in self.connection_to_user:
                del self.connection_to_user[websocket]
                
            logger.info(f"❌ WebSocket bağlantısı kesildi: {user_id}")
            
        except Exception as e:
            logger.error(f"❌ Bağlantı kesme hatası: {e}")
    
    async def disconnect_all(self):
        """Tüm bağlantıları kes"""
        for user_id, connections in self.active_connections.items():
            for websocket in connections:
                try:
                    await websocket.close()
                except:
                    pass
        
        self.active_connections.clear()
        self.connection_to_user.clear()
        self.active_users.clear()
        
        logger.info("🛑 Tüm WebSocket bağlantıları kapatıldı")
    
    async def send_message(self, user_id: str, message: dict):
        """Belirli bir kullanıcıya mesaj gönder"""
        if user_id not in self.active_connections:
            logger.warning(f"⚠️ Kullanıcı bulunamadı: {user_id}")
            return False
        
        message_str = json.dumps(message)
        disconnected_connections = []
        
        for websocket in self.active_connections[user_id]:
            try:
                await websocket.send_text(message_str)
            except Exception as e:
                logger.error(f"❌ Mesaj gönderilemedi {user_id}: {e}")
                disconnected_connections.append(websocket)
        
        # Kırık bağlantıları temizle
        for websocket in disconnected_connections:
            self.disconnect(websocket, user_id)
        
        return len(disconnected_connections) == 0
    
    async def broadcast(self, message: dict):
        """Tüm kullanıcılara mesaj gönder"""
        message_str = json.dumps(message)
        total_sent = 0
        
        for user_id, connections in self.active_connections.items():
            for websocket in connections:
                try:
                    await websocket.send_text(message_str)
                    total_sent += 1
                except Exception as e:
                    logger.error(f"❌ Broadcast hatası {user_id}: {e}")
                    self.disconnect(websocket, user_id)
        
        logger.info(f"📡 Broadcast gönderildi: {total_sent} kullanıcı")
        return total_sent
    
    async def send_to_multiple(self, user_ids: List[str], message: dict):
        """Birden fazla kullanıcıya mesaj gönder"""
        message_str = json.dumps(message)
        total_sent = 0
        
        for user_id in user_ids:
            if await self.send_message(user_id, message):
                total_sent += 1
        
        logger.info(f"📨 Çoklu mesaj gönderildi: {total_sent}/{len(user_ids)} kullanıcı")
        return total_sent
    
    def get_active_users(self) -> List[str]:
        """Aktif kullanıcıları getir"""
        return list(self.active_users)
    
    def get_connection_count(self, user_id: str = None) -> int:
        """Bağlantı sayısını getir"""
        if user_id:
            return len(self.active_connections.get(user_id, []))
        return sum(len(connections) for connections in self.active_connections.values())
    
    def is_user_connected(self, user_id: str) -> bool:
        """Kullanıcının bağlı olup olmadığını kontrol et"""
        return user_id in self.active_users
    
    async def ping_all(self):
        """Tüm kullanıcılara ping gönder"""
        ping_message = {
            "type": "ping",
            "timestamp": "now"
        }
        
        await self.broadcast(ping_message)
        logger.info(f"🏓 Ping gönderildi: {len(self.active_users)} kullanıcı")
    
    async def send_notification(self, user_id: str, title: str, message: str, notification_type: str = "info"):
        """Bildirim gönder"""
        notification = {
            "type": "notification",
            "data": {
                "title": title,
                "message": message,
                "type": notification_type,
                "timestamp": "now"
            }
        }
        
        await self.send_message(user_id, notification)
        logger.info(f"🔔 Bildirim gönderildi: {user_id} - {title}")

# Singleton instance
connection_manager = ConnectionManager()
