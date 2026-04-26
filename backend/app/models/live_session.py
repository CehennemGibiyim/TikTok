#!/usr/bin/env python3
"""
Live Session Model - Canlı yayın oturumu modeli
"""

from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, ForeignKey, Float
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from datetime import datetime

from app.core.database import Base

class LiveSession(Base):
    """Canlı yayın oturumu modeli"""
    __tablename__ = "live_sessions"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    
    # TikTok yayın bilgileri
    live_id = Column(String(100), nullable=False, index=True)
    room_id = Column(String(100), nullable=True)
    streamer_username = Column(String(100), nullable=False)
    streamer_user_id = Column(String(100), nullable=True)
    
    # Oturum bilgileri
    title = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    viewer_count = Column(Integer, default=0)
    
    # Durum
    is_active = Column(Boolean, default=True)
    is_recording = Column(Boolean, default=False)
    
    # Zaman damgaları
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    ended_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # İstatistikler
    total_gifts_received = Column(Integer, default=0)
    total_gifts_sent = Column(Integer, default=0)
    total_chests_detected = Column(Integer, default=0)
    total_value_received = Column(Float, default=0.0)
    total_value_sent = Column(Float, default=0.0)
    
    # İlişkiler
    user = relationship("User", back_populates="live_sessions")
    gifts = relationship("Gift", back_populates="session", cascade="all, delete-orphan")
    chests = relationship("Chest", back_populates="session", cascade="all, delete-orphan")
    
    def __repr__(self):
        return f"<LiveSession(id={self.id}, live_id={self.live_id}, user_id={self.user_id})>"
    
    def to_dict(self) -> dict:
        """Session'ı dictionary'e çevir"""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "live_id": self.live_id,
            "room_id": self.room_id,
            "streamer_username": self.streamer_username,
            "streamer_user_id": self.streamer_user_id,
            "title": self.title,
            "description": self.description,
            "viewer_count": self.viewer_count,
            "is_active": self.is_active,
            "is_recording": self.is_recording,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "total_gifts_received": self.total_gifts_received,
            "total_gifts_sent": self.total_gifts_sent,
            "total_chests_detected": self.total_chests_detected,
            "total_value_received": self.total_value_received,
            "total_value_sent": self.total_value_sent
        }
    
    def update_stats(self):
        """Oturum istatistiklerini güncelle"""
        if self.gifts:
            self.total_gifts_received = len([g for g in self.gifts if g.is_received])
            self.total_gifts_sent = len([g for g in self.gifts if not g.is_received])
            self.total_value_received = sum(g.value for g in self.gifts if g.is_received)
            self.total_value_sent = sum(g.value for g in self.gifts if not g.is_received)
        
        if self.chests:
            self.total_chests_detected = len(self.chests)
    
    def end_session(self):
        """Oturumu bitir"""
        self.is_active = False
        self.ended_at = datetime.utcnow()
        self.update_stats()
