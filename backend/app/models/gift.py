#!/usr/bin/env python3
"""
Gift Model - Hediye veritabanı modeli
"""

from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, ForeignKey, Float
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from datetime import datetime

from app.core.database import Base

class Gift(Base):
    """Hediye modeli"""
    __tablename__ = "gifts"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("live_sessions.id"), nullable=True)
    
    # Hediye bilgileri
    gift_id = Column(String(100), nullable=False, index=True)
    gift_name = Column(String(200), nullable=False)
    gift_type = Column(String(50), nullable=True)
    gift_count = Column(Integer, default=1)
    gift_cost = Column(Float, default=0.0)
    value = Column(Float, default=0.0)
    
    # Gönderici bilgileri
    sender_id = Column(String(100), nullable=True)
    sender_username = Column(String(100), nullable=True)
    is_received = Column(Boolean, default=True)  # True: received, False: sent
    
    # TikTok spesifik
    repeat_count = Column(Integer, default=1)
    streak_id = Column(String(100), nullable=True)
    is_streakable = Column(Boolean, default=False)
    is_repeat_end = Column(Boolean, default=False)
    
    # Ek bilgiler
    message = Column(Text, nullable=True)
    room_id = Column(String(100), nullable=True)
    
    # Zaman damgaları
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # İlişkiler
    user = relationship("User", back_populates="gifts")
    session = relationship("LiveSession", back_populates="gifts")
    
    def __repr__(self):
        return f"<Gift(id={self.id}, gift_name={self.gift_name}, user_id={self.user_id})>"
    
    def to_dict(self) -> dict:
        """Gift'i dictionary'e çevir"""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "gift_id": self.gift_id,
            "gift_name": self.gift_name,
            "gift_type": self.gift_type,
            "gift_count": self.gift_count,
            "gift_cost": self.gift_cost,
            "value": self.value,
            "sender_id": self.sender_id,
            "sender_username": self.sender_username,
            "is_received": self.is_received,
            "repeat_count": self.repeat_count,
            "streak_id": self.streak_id,
            "is_streakable": self.is_streakable,
            "is_repeat_end": self.is_repeat_end,
            "message": self.message,
            "room_id": self.room_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }
    
    @classmethod
    def from_tiktok_event(cls, event_data: dict, user_id: int, session_id: int = None):
        """TikTok event verisinden gift oluştur"""
        return cls(
            user_id=user_id,
            session_id=session_id,
            gift_id=event_data.get("gift_id"),
            gift_name=event_data.get("gift_name"),
            gift_type=event_data.get("gift_type"),
            gift_count=event_data.get("gift_count", 1),
            gift_cost=event_data.get("gift_cost", 0),
            value=event_data.get("gift_cost", 0),
            sender_id=event_data.get("sender_id"),
            sender_username=event_data.get("sender_username"),
            is_received=event_data.get("is_received", True),
            repeat_count=event_data.get("repeat_count", 1),
            streak_id=event_data.get("streak_id"),
            is_streakable=event_data.get("is_streakable", False),
            is_repeat_end=event_data.get("is_repeat_end", False),
            message=event_data.get("message"),
            room_id=event_data.get("room_id")
        )
