#!/usr/bin/env python3
"""
TikTok Schemas - Pydantic modelleri
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime

class LiveStreamRequest(BaseModel):
    """Canlı yayın isteği model"""
    live_id: str = Field(..., description="TikTok live ID")
    auto_start: bool = Field(default=False, description="Otomatik başlat")

class LiveStreamResponse(BaseModel):
    """Canlı yayın cevap model"""
    live_id: str
    room_id: str
    status: str
    viewer_count: int
    start_time: str
    total_gifts: int
    total_value: float
    
    class Config:
        from_attributes = True

class GiftSendRequest(BaseModel):
    """Hediye gönderme isteği model"""
    receiver_id: str = Field(..., description="Alıcı ID")
    gift_id: str = Field(..., description="Hediye ID")
    count: int = Field(default=1, description="Hediye sayısı")
    message: Optional[str] = Field(None, description="Mesaj")

class GiftInfo(BaseModel):
    """Hediye bilgileri model"""
    id: str
    name: str
    cost: int
    icon: str
    description: Optional[str] = None

class UserStatsResponse(BaseModel):
    """Kullanıcı istatistikleri cevap model"""
    total_gifts_sent: int
    total_gifts_received: int
    total_value_sent: float
    total_value_received: float
    total_chests_collected: int
    total_chests_value: float
    active_sessions: int
    last_activity: Optional[datetime] = None
    
    class Config:
        from_attributes = True

class GiftEvent(BaseModel):
    """Hediye olayı model"""
    gift_id: str
    gift_name: str
    gift_type: Optional[str] = None
    gift_count: int
    gift_cost: float
    value: float
    sender_id: Optional[str] = None
    sender_username: Optional[str] = None
    is_received: bool = True
    repeat_count: int = 1
    streak_id: Optional[str] = None
    is_streakable: bool = False
    is_repeat_end: bool = False
    message: Optional[str] = None
    room_id: Optional[str] = None
    timestamp: datetime

class ChestEvent(BaseModel):
    """Sandık olayı model"""
    chest_id: str
    chest_type: str
    chest_name: Optional[str] = None
    value: float
    room_id: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    envelope_id: Optional[str] = None
    event_type: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    timestamp: datetime

class CommentEvent(BaseModel):
    """Yorum olayı model"""
    user_id: str
    username: str
    comment: str
    room_id: Optional[str] = None
    timestamp: datetime

class LiveStreamInfo(BaseModel):
    """Canlı yayın bilgileri model"""
    session_id: int
    live_id: str
    room_id: str
    status: str
    viewer_count: int
    total_gifts: int
    total_value: float
    start_time: str
    duration: str
    
    class Config:
        from_attributes = True

class ConnectionStatus(BaseModel):
    """Bağlantı durumu model"""
    websocket_connected: bool
    connection_count: int
    active_streams: List[str]
    total_active_users: int
