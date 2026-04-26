#!/usr/bin/env python3
"""
Authentication Schemas - Pydantic modelleri
"""

from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime

class UserBase(BaseModel):
    """Kullanıcı base model"""
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=50)
    full_name: Optional[str] = None
    bio: Optional[str] = None

class UserCreate(UserBase):
    """Kullanıcı oluşturma model"""
    password: str = Field(..., min_length=6, max_length=100)

class UserLogin(BaseModel):
    """Kullanıcı giriş model"""
    email: EmailStr
    password: str

class UserResponse(UserBase):
    """Kullanıcı cevap model"""
    id: int
    is_active: bool
    is_verified: bool
    is_premium: bool
    tiktok_username: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    last_login: Optional[datetime] = None
    
    class Config:
        from_attributes = True

class Token(BaseModel):
    """Token model"""
    access_token: str
    token_type: str
    expires_in: int

class TokenData(BaseModel):
    """Token verisi model"""
    user_id: Optional[str] = None
