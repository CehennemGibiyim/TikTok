#!/usr/bin/env python3
"""
TikTok Router - TikTok API işlemleri
"""

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from typing import List, Dict, Any
import asyncio

from app.core.database import get_db
from app.api.routers.auth import get_current_user
from app.models.user import User
from app.services.tiktok_service import tiktok_service
from app.core.websocket import connection_manager
from app.schemas.tiktok import (
    LiveStreamRequest, 
    GiftSendRequest, 
    UserStatsResponse,
    LiveStreamResponse
)

router = APIRouter()

@router.post("/subscribe-live")
async def subscribe_to_live(
    request: LiveStreamRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Canlı yayına abone ol"""
    try:
        success = await tiktok_service.subscribe_to_live(
            live_id=request.live_id,
            user_id=str(current_user.id)
        )
        
        if success:
            return {
                "success": True,
                "message": f"Successfully subscribed to {request.live_id}",
                "live_id": request.live_id
            }
        else:
            raise HTTPException(
                status_code=400,
                detail="Failed to subscribe to live stream"
            )
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Subscription error: {str(e)}"
        )

@router.post("/start-chest-detection")
async def start_chest_detection(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Sandık tespitini başlat"""
    try:
        success = await tiktok_service.start_chest_detection(str(current_user.id))
        
        if success:
            return {
                "success": True,
                "message": "Chest detection started successfully"
            }
        else:
            raise HTTPException(
                status_code=400,
                detail="No active live streams found"
            )
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Chest detection error: {str(e)}"
        )

@router.post("/send-gift")
async def send_gift(
    request: GiftSendRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Hediye gönder"""
    try:
        result = await tiktok_service.send_gift(
            user_id=str(current_user.id),
            gift_data=request.dict()
        )
        
        if result.get("success"):
            return result
        else:
            raise HTTPException(
                status_code=400,
                detail=result.get("error", "Failed to send gift")
            )
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Gift sending error: {str(e)}"
        )

@router.get("/user-stats", response_model=UserStatsResponse)
async def get_user_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Kullanıcı istatistiklerini getir"""
    try:
        result = await tiktok_service.get_user_stats(str(current_user.id))
        
        if result.get("success"):
            return UserStatsResponse(**result["data"])
        else:
            raise HTTPException(
                status_code=400,
                detail=result.get("error", "Failed to get user stats")
            )
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Stats error: {str(e)}"
        )

@router.get("/live-streams", response_model=List[LiveStreamResponse])
async def get_live_streams(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Aktif canlı yayınları getir"""
    try:
        # Aktif bağlantıları getir
        active_streams = []
        for client_key, client in tiktok_service.active_clients.items():
            if str(current_user.id) in client_key:
                # Canlı yayın bilgilerini al
                stream_info = {
                    "live_id": client_key.split("_")[1] if "_" in client_key else "unknown",
                    "room_id": getattr(client, 'room_id', 'unknown'),
                    "status": "connected",
                    "viewer_count": 0,  # TikTokLive'dan alınabilir
                    "start_time": "unknown"
                }
                active_streams.append(LiveStreamResponse(**stream_info))
        
        return active_streams
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Live streams error: {str(e)}"
        )

@router.post("/unsubscribe-live/{live_id}")
async def unsubscribe_from_live(
    live_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Canlı yayın aboneliğini iptal et"""
    try:
        client_key = f"{current_user.id}_{live_id}"
        
        if client_key in tiktok_service.active_clients:
            client = tiktok_service.active_clients[client_key]
            await client.disconnect()
            del tiktok_service.active_clients[client_key]
            
            return {
                "success": True,
                "message": f"Unsubscribed from {live_id}"
            }
        else:
            raise HTTPException(
                status_code=404,
                detail="Live stream not found"
            )
            
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Unsubscribe error: {str(e)}"
        )

@router.get("/gift-list")
async def get_gift_list(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Mevcut hediyeleri getir"""
    try:
        # TikTokLive'dan mevcut hediyeleri al
        gifts = [
            {"id": "1", "name": "Rose", "cost": 1, "icon": "🌹"},
            {"id": "2", "name": "TikTok", "cost": 1, "icon": "🎵"},
            {"id": "3", "name": "Heart", "cost": 1, "icon": "❤️"},
            {"id": "4", "name": "Finger Heart", "cost": 5, "icon": "🤟"},
            {"id": "5", "name": "Cap", "cost": 1, "icon": "🧢"},
            {"id": "6", "name": "Coffee", "cost": 5, "icon": "☕"},
            {"id": "7", "name": "Ice Cream Cone", "cost": 1, "icon": "🍦"},
            {"id": "8", "name": "Ice Cream", "cost": 7, "icon": "🍨"},
            {"id": "9", "name": "Panda", "cost": 5, "icon": "🐼"},
            {"id": "10", "name": "Love Bang", "cost": 1, "icon": "💥"},
            {"id": "11", "name": "Confetti", "cost": 1, "icon": "🎊"},
            {"id": "12", "name": "Mickey", "cost": 100, "icon": "🐭"},
            {"id": "13", "name": "Heart Hands", "cost": 5, "icon": "🫶"},
            {"id": "14", "name": "Burger", "cost": 5, "icon": "🍔"},
            {"id": "15", "name": "French Fries", "cost": 5, "icon": "🍟"},
            {"id": "16", "name": "Fire", "cost": 100, "icon": "🔥"},
            {"id": "17", "name": "Little Crown", "cost": 99, "icon": "👑"},
            {"id": "18", "name": "Love You", "cost": 20, "icon": "💝"},
            {"id": "19", "name": "Paper Plane", "cost": 1, "icon": "✈️"},
            {"id": "20", "name": "Clap", "cost": 1, "icon": "👏"},
        ]
        
        return {"gifts": gifts}
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Gift list error: {str(e)}"
        )

@router.get("/connection-status")
async def get_connection_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Bağlantı durumunu getir"""
    try:
        user_id = str(current_user.id)
        is_connected = connection_manager.is_user_connected(user_id)
        connection_count = connection_manager.get_connection_count(user_id)
        
        active_streams = []
        for client_key, client in tiktok_service.active_clients.items():
            if user_id in client_key:
                active_streams.append(client_key.split("_")[1] if "_" in client_key else "unknown")
        
        return {
            "websocket_connected": is_connected,
            "connection_count": connection_count,
            "active_streams": active_streams,
            "total_active_users": len(connection_manager.get_active_users())
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Connection status error: {str(e)}"
        )
