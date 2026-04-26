#!/usr/bin/env python3
"""
Dashboard Router - Dashboard verileri
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, desc
from datetime import datetime, timedelta
from typing import List, Dict, Any

from app.core.database import get_db
from app.api.routers.auth import get_current_user
from app.models.user import User
from app.models.live_session import LiveSession
from app.models.gift import Gift
from app.models.chest import Chest
from app.schemas.dashboard import (
    DashboardResponse,
    QuickStats,
    RecentActivity,
    LiveStreamInfo,
    NotificationData
)

router = APIRouter()

@router.get("/", response_model=DashboardResponse)
async def get_dashboard_data(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Ana dashboard verileri"""
    try:
        user_id = current_user.id
        today = datetime.now().date()
        week_ago = datetime.now() - timedelta(days=7)
        
        # Hızlı istatistikler
        quick_stats = await get_quick_stats(user_id, db)
        
        # Son aktiviteler
        recent_activity = await get_recent_activity(user_id, db)
        
        # Canlı yayın bilgileri
        live_streams = await get_live_stream_info(user_id, db)
        
        # Bildirimler
        notifications = await get_notifications(user_id, db)
        
        return DashboardResponse(
            quick_stats=quick_stats,
            recent_activity=recent_activity,
            live_streams=live_streams,
            notifications=notifications,
            last_updated=datetime.now().isoformat()
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Dashboard data error: {str(e)}"
        )

async def get_quick_stats(user_id: int, db: Session) -> QuickStats:
    """Hızlı istatistikler"""
    try:
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Bugünkü hediyeler
        today_gifts = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= today_start
            )
        ).count()
        
        # Bugünkü sandıklar
        today_chests = db.query(Chest).filter(
            and_(
                Chest.user_id == user_id,
                Chest.created_at >= today_start
            )
        ).count()
        
        # Bugünkü değer
        today_value = db.query(func.sum(Gift.value)).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= today_start
            )
        ).scalar() or 0
        
        # Haftalık karşılaştırma
        week_ago_start = today_start - timedelta(days=7)
        week_gifts = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= week_ago_start
            )
        ).count()
        
        # Aktif oturumlar
        active_sessions = db.query(LiveSession).filter(
            and_(
                LiveSession.user_id == user_id,
                LiveSession.is_active == True
            )
        ).count()
        
        return QuickStats(
            today_gifts=today_gifts,
            today_chests=today_chests,
            today_value=float(today_value),
            weekly_gifts=week_gifts,
            active_sessions=active_sessions,
            gift_growth=calculate_growth(today_gifts, week_gifts / 7)
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Quick stats error: {str(e)}"
        )

async def get_recent_activity(user_id: int, db: Session, limit: int = 10) -> List[RecentActivity]:
    """Son aktiviteler"""
    try:
        activities = []
        
        # Son hediyeler
        recent_gifts = db.query(Gift).filter(
            Gift.user_id == user_id
        ).order_by(desc(Gift.created_at)).limit(limit // 2).all()
        
        for gift in recent_gifts:
            activities.append(RecentActivity(
                id=gift.id,
                type="gift",
                title=f"Gift Received: {gift.gift_name}",
                description=f"From {gift.sender_username}",
                value=float(gift.value),
                timestamp=gift.created_at.isoformat(),
                metadata={
                    "gift_id": gift.gift_id,
                    "sender_id": gift.sender_id
                }
            ))
        
        # Son sandıklar
        recent_chests = db.query(Chest).filter(
            Chest.user_id == user_id
        ).order_by(desc(Chest.created_at)).limit(limit // 2).all()
        
        for chest in recent_chests:
            activities.append(RecentActivity(
                id=chest.id,
                type="chest",
                title=f"Chest Detected: {chest.chest_type}",
                description=f"Value: {chest.value} coins",
                value=float(chest.value),
                timestamp=chest.created_at.isoformat(),
                metadata={
                    "chest_type": chest.chest_type,
                    "room_id": chest.room_id
                }
            ))
        
        # Tarih sırasına göre düzenle
        activities.sort(key=lambda x: x.timestamp, reverse=True)
        return activities[:limit]
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Recent activity error: {str(e)}"
        )

async def get_live_stream_info(user_id: int, db: Session) -> List[LiveStreamInfo]:
    """Canlı yayın bilgileri"""
    try:
        # Aktif oturumları getir
        active_sessions = db.query(LiveSession).filter(
            and_(
                LiveSession.user_id == user_id,
                LiveSession.is_active == True
            )
        ).all()
        
        live_streams = []
        for session in active_sessions:
            # Oturum istatistikleri
            session_gifts = db.query(Gift).filter(
                Gift.session_id == session.id
            ).count()
            
            session_value = db.query(func.sum(Gift.value)).filter(
                Gift.session_id == session.id
            ).scalar() or 0
            
            live_streams.append(LiveStreamInfo(
                session_id=session.id,
                live_id=session.live_id,
                room_id=session.room_id,
                status="active",
                viewer_count=session.viewer_count or 0,
                total_gifts=session_gifts,
                total_value=float(session_value),
                start_time=session.started_at.isoformat(),
                duration=str(datetime.now() - session.started_at).split('.')[0]
            ))
        
        return live_streams
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Live stream info error: {str(e)}"
        )

async def get_notifications(user_id: int, db: Session, limit: int = 5) -> List[NotificationData]:
    """Bildirimler"""
    try:
        notifications = []
        
        # Yeni sandık bildirimleri
        recent_chests = db.query(Chest).filter(
            and_(
                Chest.user_id == user_id,
                Chest.created_at >= datetime.now() - timedelta(hours=1)
            )
        ).all()
        
        for chest in recent_chests:
            notifications.append(NotificationData(
                id=f"chest_{chest.id}",
                type="chest_detected",
                title="New Chest Detected!",
                message=f"{chest.chest_type} chest worth {chest.value} coins",
                timestamp=chest.created_at.isoformat(),
                is_read=False,
                priority="high"
            ))
        
        # Yeni hediye bildirimleri
        recent_gifts = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= datetime.now() - timedelta(hours=1)
            )
        ).all()
        
        for gift in recent_gifts:
            notifications.append(NotificationData(
                id=f"gift_{gift.id}",
                type="gift_received",
                title="Gift Received!",
                message=f"{gift.gift_name} from {gift.sender_username}",
                timestamp=gift.created_at.isoformat(),
                is_read=False,
                priority="medium"
            ))
        
        # Tarih sırasına göre düzenle
        notifications.sort(key=lambda x: x.timestamp, reverse=True)
        return notifications[:limit]
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Notifications error: {str(e)}"
        )

def calculate_growth(current: int, previous: float) -> float:
    """Büyüme yüzdesi hesapla"""
    if previous == 0:
        return 100.0 if current > 0 else 0.0
    
    return ((current - previous) / previous) * 100

@router.get("/stats/overview")
async def get_stats_overview(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 30
):
    """Genel istatistikler"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Toplam metrikler
        total_gifts = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).count()
        
        total_chests = db.query(Chest).filter(
            and_(
                Chest.user_id == user_id,
                Chest.created_at >= start_date
            )
        ).count()
        
        total_value = db.query(func.sum(Gift.value)).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).scalar() or 0
        
        # En aktif gün
        most_active_day = db.query(
            func.date(Gift.created_at).label('day'),
            func.count(Gift.id).label('count')
        ).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).group_by(func.date(Gift.created_at)).order_by(desc(func.count(Gift.id))).first()
        
        # En değerli hediye
        most_valuable_gift = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).order_by(desc(Gift.value)).first()
        
        return {
            "total_gifts": total_gifts,
            "total_chests": total_chests,
            "total_value": float(total_value),
            "avg_daily_gifts": total_gifts / days if days > 0 else 0,
            "avg_daily_chests": total_chests / days if days > 0 else 0,
            "most_active_day": most_active_day.day.isoformat() if most_active_day else None,
            "most_active_gifts": most_active_day.count if most_active_day else 0,
            "most_valuable_gift": most_valuable_gift.value if most_valuable_gift else 0,
            "period_days": days
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Stats overview error: {str(e)}"
        )

@router.get("/activity/chart")
async def get_activity_chart(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 7
):
    """Aktivite grafiği verileri"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        chart_data = []
        current_date = start_date
        
        while current_date <= datetime.now():
            # Gün başı ve sonu
            day_start = current_date.replace(hour=0, minute=0, second=0, microsecond=0)
            day_end = current_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            
            # Gün içindeki aktiviteler
            day_gifts = db.query(Gift).filter(
                and_(
                    Gift.user_id == user_id,
                    Gift.created_at >= day_start,
                    Gift.created_at <= day_end
                )
            ).count()
            
            day_chests = db.query(Chest).filter(
                and_(
                    Chest.user_id == user_id,
                    Chest.created_at >= day_start,
                    Chest.created_at <= day_end
                )
            ).count()
            
            day_value = db.query(func.sum(Gift.value)).filter(
                and_(
                    Gift.user_id == user_id,
                    Gift.created_at >= day_start,
                    Gift.created_at <= day_end
                )
            ).scalar() or 0
            
            chart_data.append({
                "date": current_date.date().isoformat(),
                "gifts": day_gifts,
                "chests": day_chests,
                "value": float(day_value)
            })
            
            current_date += timedelta(days=1)
        
        return chart_data
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Activity chart error: {str(e)}"
        )
