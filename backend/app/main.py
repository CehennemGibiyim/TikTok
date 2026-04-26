#!/usr/bin/env python3
"""
TikTok Panel Backend - FastAPI Ana Uygulaması
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uvicorn
import asyncio
import json
from datetime import datetime

from app.core.config import settings
from app.api.routers import auth, tiktok, analytics, dashboard
from app.core.websocket import ConnectionManager
from app.services.tiktok_service import TikTokService
from app.core.database import engine, Base

# Veritabanı tablolarını oluştur
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="TikTok Panel API",
    description="TikTok jeton yönetim paneli API",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# CORS ayarları
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Serve index.html
@app.get("/")
async def serve_index():
    """Ana sayfa için index.html serve et"""
    from fastapi.responses import FileResponse
    return FileResponse("static/index.html")

# WebSocket Connection Manager
manager = ConnectionManager()

# Router'ları ekle
app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(tiktok.router, prefix="/api/tiktok", tags=["TikTok"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["Analytics"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard"])

# TikTok servisi
tiktok_service = TikTokService()

@app.get("/")
async def root():
    """Ana endpoint"""
    return {
        "message": "TikTok Panel API",
        "status": "running",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.0"
    }

@app.get("/api/health")
async def health_check():
    """Sağlık kontrolü"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "services": {
            "database": "connected",
            "redis": "connected",
            "tiktok_api": "ready"
        }
    }

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    """WebSocket endpoint for real-time updates"""
    await manager.connect(websocket, user_id)
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Mesaj tipine göre işlem yap
            if message["type"] == "subscribe":
                # Canlı yayın aboneliği
                await handle_subscription(websocket, user_id, message["data"])
            elif message["type"] == "command":
                # Komut işle
                await handle_command(websocket, user_id, message["data"])
            elif message["type"] == "ping":
                # Ping-pong
                await websocket.send_text(json.dumps({"type": "pong"}))
                
    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id)

async def handle_subscription(websocket: WebSocket, user_id: str, data: dict):
    """Canlı yayın aboneliği işle"""
    try:
        if data.get("action") == "subscribe_live":
            # TikTok canlı yayın aboneliği
            live_id = data.get("live_id")
            
            # TikTok servisi ile aboneliği başlat
            await tiktok_service.subscribe_to_live(live_id, user_id)
            
            # Kullanıcıya bildir
            await websocket.send_text(json.dumps({
                "type": "subscription_success",
                "data": {"live_id": live_id}
            }))
            
    except Exception as e:
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": str(e)
        }))

async def handle_command(websocket: WebSocket, user_id: str, data: dict):
    """Komut işle"""
    try:
        if data.get("action") == "start_chest_detection":
            # Sandık tespitini başlat
            await tiktok_service.start_chest_detection(user_id)
            
            await websocket.send_text(json.dumps({
                "type": "command_success",
                "data": {"action": "chest_detection_started"}
            }))
            
        elif data.get("action") == "send_gift":
            # Hediye gönder
            gift_data = data.get("gift_data")
            result = await tiktok_service.send_gift(user_id, gift_data)
            
            await websocket.send_text(json.dumps({
                "type": "gift_result",
                "data": result
            }))
            
    except Exception as e:
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": str(e)
        }))

@app.on_event("startup")
async def startup_event():
    """Uygulama başlangıç eventi"""
    print("🚀 TikTok Panel API başlatılıyor...")
    print(f"📡 WebSocket endpoint: ws://localhost:8000/ws/{{user_id}}")
    print(f"📚 API Documentation: http://localhost:8000/api/docs")
    
    # TikTok servisini başlat
    await tiktok_service.initialize()

@app.on_event("shutdown")
async def shutdown_event():
    """Uygulama kapanış eventi"""
    print("🛑 TikTok Panel API kapatılıyor...")
    
    # Tüm bağlantıları kapat
    await manager.disconnect_all()
    
    # TikTok servisini kapat
    await tiktok_service.shutdown()

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
