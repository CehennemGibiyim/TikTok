#!/usr/bin/env python3
"""
Database Configuration - Veritabanı bağlantısı ve konfigürasyonu
"""

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.core.config import settings

# Veritabanı engine'i oluştur
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_recycle=300,
    echo=settings.debug
)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base model
Base = declarative_base()

def get_db():
    """Veritabanı session'ı getir"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    """Veritabanını başlat"""
    Base.metadata.create_all(bind=engine)

def drop_db():
    """Veritabanını sil"""
    Base.metadata.drop_all(bind=engine)
