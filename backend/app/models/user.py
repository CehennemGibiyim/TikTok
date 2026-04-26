#!/usr/bin/env python3
"""
User Model - Kullanıcı veritabanı modeli
"""

from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from passlib.context import CryptContext
from datetime import datetime

from app.core.database import Base

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

class User(Base):
    """Kullanıcı modeli"""
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    username = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    
    # Profil bilgileri
    full_name = Column(String(255), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    bio = Column(Text, nullable=True)
    
    # TikTok bilgileri
    tiktok_username = Column(String(100), nullable=True)
    tiktok_user_id = Column(String(100), nullable=True)
    tiktok_access_token = Column(Text, nullable=True)
    
    # Status
    is_active = Column(Boolean, default=True)
    is_verified = Column(Boolean, default=False)
    is_premium = Column(Boolean, default=False)
    
    # Zaman damgaları
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    last_login = Column(DateTime(timezone=True), nullable=True)
    
    # İlişkiler
    live_sessions = relationship("LiveSession", back_populates="user", cascade="all, delete-orphan")
    gifts = relationship("Gift", back_populates="user", cascade="all, delete-orphan")
    chests = relationship("Chest", back_populates="user", cascade="all, delete-orphan")
    
    def __repr__(self):
        return f"<User(id={self.id}, email={self.email}, username={self.username})>"
    
    @staticmethod
    def get_password_hash(password: str) -> str:
        """Şifre hash'i oluştur"""
        return pwd_context.hash(password)
    
    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Şifreyi doğrula"""
        return pwd_context.verify(plain_password, hashed_password)
    
    def to_dict(self) -> dict:
        """User'ı dictionary'e çevir"""
        return {
            "id": self.id,
            "email": self.email,
            "username": self.username,
            "full_name": self.full_name,
            "avatar_url": self.avatar_url,
            "bio": self.bio,
            "tiktok_username": self.tiktok_username,
            "is_active": self.is_active,
            "is_verified": self.is_verified,
            "is_premium": self.is_premium,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "last_login": self.last_login.isoformat() if self.last_login else None
        }
