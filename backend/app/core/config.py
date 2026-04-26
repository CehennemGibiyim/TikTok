#!/usr/bin/env python3
"""
TikTok Panel - Konfigürasyon Ayarları
"""

from pydantic_settings import BaseSettings
from typing import Optional
import os

class Settings(BaseSettings):
    """Ana ayarlar sınıfı"""
    
    # Uygulama ayarları
    app_name: str = "TikTok Panel"
    app_version: str = "1.0.0"
    debug: bool = True
    
    # Server ayarları
    host: str = "0.0.0.0"
    port: int = 8000
    
    # Veritabanı ayarları
    database_url: str = "postgresql://user:password@localhost/tiktok_panel"
    redis_url: str = "redis://localhost:6379"
    
    # JWT ayarları
    secret_key: str = "your-secret-key-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    
    # TikTok API ayarları
    tiktok_api_key: Optional[str] = None
    tiktok_base_url: str = "https://api.tikapi.io/v3"
    
    # TikTokLive ayarları
    tiktok_live_enabled: bool = True
    max_concurrent_streams: int = 100
    
    # WebSocket ayarları
    websocket_ping_interval: int = 20
    websocket_ping_timeout: int = 10
    
    # Rate limiting
    rate_limit_per_minute: int = 60
    rate_limit_per_hour: int = 1000
    
    # Güvenlik ayarları
    cors_origins: list = ["http://localhost:3000", "http://127.0.0.1:3000"]
    allowed_hosts: list = ["localhost", "127.0.0.1"]
    
    # Log ayarları
    log_level: str = "INFO"
    log_file: str = "logs/tiktok_panel.log"
    
    # Cache ayarları
    cache_ttl_seconds: int = 300  # 5 dakika
    max_cache_size: int = 1000
    
    # Monitoring
    enable_metrics: bool = True
    metrics_port: int = 9090
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

# Ayarları yükle
settings = Settings()

# Geliştirme ortamı kontrolleri
if settings.debug:
    print("🔧 Debug modu aktif")
    print(f"📊 Database: {settings.database_url}")
    print(f"🔴 Redis: {settings.redis_url}")
    print(f"🔑 JWT Secret: {'*' * 10 + settings.secret_key[-4:] if settings.secret_key else 'None'}")
