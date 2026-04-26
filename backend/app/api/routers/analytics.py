#!/usr/bin/env python3
"""
Analytics Router - Analitik ve istatistikler
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
from app.schemas.analytics import (
    AnalyticsResponse,
    GiftAnalytics,
    ChestAnalytics,
    TrendData,
    PerformanceMetrics
)

router = APIRouter()

@router.get("/dashboard", response_model=AnalyticsResponse)
async def get_dashboard_analytics(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 7
):
    """Dashboard analitik verileri"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Toplam hediyeler
        total_gifts = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).count()
        
        # Toplam sandıklar
        total_chests = db.query(Chest).filter(
            and_(
                Chest.user_id == user_id,
                Chest.created_at >= start_date
            )
        ).count()
        
        # Toplam değer
        total_value = db.query(func.sum(Gift.value)).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).scalar() or 0
        
        # Aktif oturumlar
        active_sessions = db.query(LiveSession).filter(
            and_(
                LiveSession.user_id == user_id,
                LiveSession.is_active == True
            )
        ).count()
        
        return AnalyticsResponse(
            total_gifts=total_gifts,
            total_chests=total_chests,
            total_value=float(total_value),
            active_sessions=active_sessions,
            period_days=days
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Dashboard analytics error: {str(e)}"
        )

@router.get("/gifts", response_model=List[GiftAnalytics])
async def get_gift_analytics(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 7
):
    """Hediye analitikleri"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Günlük hediye istatistikleri
        gift_stats = db.query(
            func.date(Gift.created_at).label('date'),
            func.count(Gift.id).label('count'),
            func.sum(Gift.value).label('total_value')
        ).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).group_by(func.date(Gift.created_at)).all()
        
        analytics = []
        for stat in gift_stats:
            analytics.append(GiftAnalytics(
                date=stat.date.isoformat(),
                count=stat.count,
                total_value=float(stat.total_value or 0)
            ))
        
        return analytics
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Gift analytics error: {str(e)}"
        )

@router.get("/chests", response_model=List[ChestAnalytics])
async def get_chest_analytics(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 7
):
    """Sandık analitikleri"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Günlük sandık istatistikleri
        chest_stats = db.query(
            func.date(Chest.created_at).label('date'),
            func.count(Chest.id).label('count'),
            func.sum(Chest.value).label('total_value'),
            Chest.chest_type
        ).filter(
            and_(
                Chest.user_id == user_id,
                Chest.created_at >= start_date
            )
        ).group_by(func.date(Chest.created_at), Chest.chest_type).all()
        
        analytics = []
        for stat in chest_stats:
            analytics.append(ChestAnalytics(
                date=stat.date.isoformat(),
                count=stat.count,
                total_value=float(stat.total_value or 0),
                chest_type=stat.chest_type
            ))
        
        return analytics
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Chest analytics error: {str(e)}"
        )

@router.get("/trends", response_model=List[TrendData])
async def get_trend_data(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 30
):
    """Trend verileri"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Son 30 günün trend verileri
        trends = []
        current_date = start_date
        
        while current_date <= datetime.now():
            # Gün başı ve sonu
            day_start = current_date.replace(hour=0, minute=0, second=0, microsecond=0)
            day_end = current_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            
            # Gün içindeki hediyeler
            day_gifts = db.query(Gift).filter(
                and_(
                    Gift.user_id == user_id,
                    Gift.created_at >= day_start,
                    Gift.created_at <= day_end
                )
            ).count()
            
            # Gün içindeki sandıklar
            day_chests = db.query(Chest).filter(
                and_(
                    Chest.user_id == user_id,
                    Chest.created_at >= day_start,
                    Chest.created_at <= day_end
                )
            ).count()
            
            trends.append(TrendData(
                date=current_date.date().isoformat(),
                gifts=day_gifts,
                chests=day_chests,
                value=float(db.query(func.sum(Gift.value)).filter(
                    and_(
                        Gift.user_id == user_id,
                        Gift.created_at >= day_start,
                        Gift.created_at <= day_end
                    )
                ).scalar() or 0)
            ))
            
            current_date += timedelta(days=1)
        
        return trends
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Trend data error: {str(e)}"
        )

@router.get("/performance", response_model=PerformanceMetrics)
async def get_performance_metrics(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 7
):
    """Performans metrikleri"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Ortalama günlük hediye sayısı
        avg_daily_gifts = db.query(func.count(Gift.id)).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).scalar() / days if days > 0 else 0
        
        # Ortalama günlük sandık sayısı
        avg_daily_chests = db.query(func.count(Chest.id)).filter(
            and_(
                Chest.user_id == user_id,
                Chest.created_at >= start_date
            )
        ).scalar() / days if days > 0 else 0
        
        # En değerli hediye
        most_valuable_gift = db.query(Gift).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).order_by(desc(Gift.value)).first()
        
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
        
        return PerformanceMetrics(
            avg_daily_gifts=float(avg_daily_gifts),
            avg_daily_chests=float(avg_daily_chests),
            most_valuable_gift=most_valuable_gift.value if most_valuable_gift else 0,
            most_active_day=most_active_day.day.isoformat() if most_active_day else None,
            most_active_gifts=most_active_day.count if most_active_day else 0
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Performance metrics error: {str(e)}"
        )

@router.get("/top-gifts")
async def get_top_gifts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = 10
):
    """En çok gönderilen hediyeler"""
    try:
        user_id = current_user.id
        
        top_gifts = db.query(
            Gift.gift_name,
            func.count(Gift.id).label('count'),
            func.sum(Gift.value).label('total_value')
        ).filter(
            Gift.user_id == user_id
        ).group_by(Gift.gift_name).order_by(desc(func.count(Gift.id))).limit(limit).all()
        
        return [
            {
                "gift_name": gift.gift_name,
                "count": gift.count,
                "total_value": float(gift.total_value or 0)
            }
            for gift in top_gifts
        ]
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Top gifts error: {str(e)}"
        )

@router.get("/hourly-stats")
async def get_hourly_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = 1
):
    """Saatlik istatistikler"""
    try:
        user_id = current_user.id
        start_date = datetime.now() - timedelta(days=days)
        
        # Saatlik istatistikler
        hourly_stats = db.query(
            func.extract('hour', Gift.created_at).label('hour'),
            func.count(Gift.id).label('count'),
            func.sum(Gift.value).label('total_value')
        ).filter(
            and_(
                Gift.user_id == user_id,
                Gift.created_at >= start_date
            )
        ).group_by(func.extract('hour', Gift.created_at)).all()
        
        # 24 saat formatında düzenle
        stats_by_hour = {hour: 0 for hour in range(24)}
        for stat in hourly_stats:
            stats_by_hour[int(stat.hour)] = stat.count
        
        return {
            "hourly_gifts": stats_by_hour,
            "peak_hour": max(stats_by_hour, key=stats_by_hour.get) if stats_by_hour else 0,
            "total_hours_active": len([h for h in stats_by_hour.values() if h > 0])
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Hourly stats error: {str(e)}"
        )
