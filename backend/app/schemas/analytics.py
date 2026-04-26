#!/usr/bin/env python3
"""
Analytics Schemas - Pydantic modelleri
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime

class AnalyticsResponse(BaseModel):
    """Analitik cevap model"""
    total_gifts: int
    total_chests: int
    total_value: float
    active_sessions: int
    period_days: int

class GiftAnalytics(BaseModel):
    """Hediye analitikleri model"""
    date: str
    count: int
    total_value: float

class ChestAnalytics(BaseModel):
    """Sandık analitikleri model"""
    date: str
    count: int
    total_value: float
    chest_type: str

class TrendData(BaseModel):
    """Trend verileri model"""
    date: str
    gifts: int
    chests: int
    value: float

class PerformanceMetrics(BaseModel):
    """Performans metrikleri model"""
    avg_daily_gifts: float
    avg_daily_chests: float
    most_valuable_gift: float
    most_active_day: Optional[str] = None
    most_active_gifts: int

class QuickStats(BaseModel):
    """Hızlı istatistikler model"""
    today_gifts: int
    today_chests: int
    today_value: float
    weekly_gifts: int
    active_sessions: int
    gift_growth: float

class RecentActivity(BaseModel):
    """Son aktiviteler model"""
    id: int
    type: str
    title: str
    description: str
    value: float
    timestamp: str
    metadata: Optional[Dict[str, Any]] = None

class LiveStreamInfo(BaseModel):
    """Canlı yayın bilgileri model"""
    session_id: int
    live_id: str
    room_id: str
    status: str
    viewer_count: int
    total_gifts: int
    total_value: float
    start_time: str
    duration: str

class NotificationData(BaseModel):
    """Bildirim verileri model"""
    id: str
    type: str
    title: str
    message: str
    timestamp: str
    is_read: bool
    priority: str

class DashboardResponse(BaseModel):
    """Dashboard cevap model"""
    quick_stats: QuickStats
    recent_activity: List[RecentActivity]
    live_streams: List[LiveStreamInfo]
    notifications: List[NotificationData]
    last_updated: str
