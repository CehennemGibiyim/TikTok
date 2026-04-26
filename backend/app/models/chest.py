#!/usr/bin/env python3
"""
Chest Model - Sandık veritabanı modeli
"""

from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, ForeignKey, Float
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from datetime import datetime

from app.core.database import Base

class Chest(Base):
    """Sandık modeli"""
    __tablename__ = "chests"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("live_sessions.id"), nullable=True)
    
    # Sandık bilgileri
    chest_id = Column(String(100), nullable=False, index=True)
    chest_type = Column(String(50), nullable=False)
    chest_name = Column(String(200), nullable=True)
    value = Column(Float, default=0.0)
    
    # Konum ve zamanlama
    room_id = Column(String(100), nullable=True)
    position_x = Column(Float, nullable=True)
    position_y = Column(Float, nullable=True)
    
    # Durum
    is_collected = Column(Boolean, default=False)
    is_expired = Column(Boolean, default=False)
    collection_time = Column(DateTime(timezone=True), nullable=True)
    expiry_time = Column(DateTime(timezone=True), nullable=True)
    
    # Kullanıcı bilgileri
    collector_id = Column(String(100), nullable=True)
    collector_username = Column(String(100), nullable=True)
    
    # TikTok spesifik
    envelope_id = Column(String(100), nullable=True)
    event_type = Column(String(50), nullable=True)
    
    # Ek bilgiler
    metadata = Column(Text, nullable=True)  # JSON string
    message = Column(Text, nullable=True)
    
    # Zaman damgaları
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # İlişkiler
    user = relationship("User", back_populates="chests")
    session = relationship("LiveSession", back_populates="chests")
    
    def __repr__(self):
        return f"<Chest(id={self.id}, chest_type={self.chest_type}, user_id={self.user_id})>"
    
    def to_dict(self) -> dict:
        """Chest'i dictionary'e çevir"""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "chest_id": self.chest_id,
            "chest_type": self.chest_type,
            "chest_name": self.chest_name,
            "value": self.value,
            "room_id": self.room_id,
            "position_x": self.position_x,
            "position_y": self.position_y,
            "is_collected": self.is_collected,
            "is_expired": self.is_expired,
            "collection_time": self.collection_time.isoformat() if self.collection_time else None,
            "expiry_time": self.expiry_time.isoformat() if self.expiry_time else None,
            "collector_id": self.collector_id,
            "collector_username": self.collector_username,
            "envelope_id": self.envelope_id,
            "event_type": self.event_type,
            "metadata": self.metadata,
            "message": self.message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }
    
    def collect(self, collector_id: str = None, collector_username: str = None):
        """Sandığı topla"""
        self.is_collected = True
        self.collection_time = datetime.utcnow()
        if collector_id:
            self.collector_id = collector_id
        if collector_username:
            self.collector_username = collector_username
    
    def expire(self):
        """Sandığın süresini doldur"""
        self.is_expired = True
        self.expiry_time = datetime.utcnow()
    
    def is_available(self) -> bool:
        """Sandık toplanabilir mi"""
        return (
            not self.is_collected 
            and not self.is_expired 
            and (
                not self.expiry_time 
                or self.expiry_time > datetime.utcnow()
            )
        )
    
    @classmethod
    def from_tiktok_event(cls, event_data: dict, user_id: int, session_id: int = None):
        """TikTok event verisinden chest oluştur"""
        return cls(
            user_id=user_id,
            session_id=session_id,
            chest_id=event_data.get("chest_id"),
            chest_type=event_data.get("chest_type", "unknown"),
            chest_name=event_data.get("chest_name"),
            value=event_data.get("value", 0),
            room_id=event_data.get("room_id"),
            position_x=event_data.get("position_x"),
            position_y=event_data.get("position_y"),
            envelope_id=event_data.get("envelope_id"),
            event_type=event_data.get("event_type"),
            metadata=event_data.get("metadata"),
            message=event_data.get("message")
        )
