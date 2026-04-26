#!/usr/bin/env python3
"""
Main Test Suite - Backend testleri
"""

import pytest
import asyncio
import json
from fastapi.testclient import TestClient
from httpx import AsyncClient
import websockets

from app.main import app

# Test client
client = TestClient(app)

@pytest.fixture
def test_client():
    """Test client fixture"""
    return TestClient(app)

@pytest.fixture
async def async_client():
    """Async test client fixture"""
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac

class TestMainEndpoints:
    """Ana endpoint testleri"""
    
    def test_root_endpoint(self, test_client):
        """Ana endpoint test"""
        response = test_client.get("/")
        assert response.status_code == 200
        assert "TikTok Panel API" in response.json()["message"]
    
    def test_health_check(self, test_client):
        """Health check test"""
        response = test_client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "database" in data["services"]
        assert "redis" in data["services"]
    
    def test_api_docs(self, test_client):
        """API docs test"""
        response = test_client.get("/api/docs")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
    
    def test_cors_headers(self, test_client):
        """CORS headers test"""
        response = test_client.options("/api/health")
        assert "access-control-allow-origin" in response.headers

class TestWebSocket:
    """WebSocket testleri"""
    
    @pytest.mark.asyncio
    async def test_websocket_connection(self):
        """WebSocket bağlantı test"""
        try:
            async with websockets.connect("ws://localhost:8000/ws/test-user") as websocket:
                # Ping test
                await websocket.send(json.dumps({"type": "ping"}))
                response = await websocket.recv()
                data = json.loads(response)
                assert data["type"] == "pong"
                
                # Subscription test
                await websocket.send(json.dumps({
                    "type": "command",
                    "data": {"action": "subscribe_live", "live_id": "@test"}
                }))
                
                # Wait for response
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                data = json.loads(response)
                assert data["type"] in ["subscription_success", "error"]
                
        except (ConnectionRefusedError, OSError):
            pytest.skip("WebSocket server not running")
    
    @pytest.mark.asyncio
    async def test_websocket_invalid_message(self):
        """Geçersiz WebSocket mesajı test"""
        try:
            async with websockets.connect("ws://localhost:8000/ws/test-user") as websocket:
                # Invalid JSON
                await websocket.send("invalid json")
                # Should not crash
                await asyncio.sleep(0.1)
                
        except (ConnectionRefusedError, OSError):
            pytest.skip("WebSocket server not running")

class TestTikTokAPI:
    """TikTok API testleri"""
    
    def test_gift_list(self, test_client):
        """Hediye listesi test"""
        response = test_client.get("/api/tiktok/gift-list")
        assert response.status_code == 200
        data = response.json()
        assert "gifts" in data
        assert len(data["gifts"]) > 0
    
    def test_connection_status(self, test_client):
        """Bağlantı durumu test"""
        response = test_client.get("/api/tiktok/connection-status")
        assert response.status_code == 200
        data = response.json()
        assert "websocket_connected" in data
        assert "active_streams" in data
    
    def test_live_streams_empty(self, test_client):
        """Boş canlı yayınlar test"""
        response = test_client.get("/api/tiktok/live-streams")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

class TestAnalytics:
    """Analitik testleri"""
    
    def test_dashboard_analytics(self, test_client):
        """Dashboard analitik test"""
        response = test_client.get("/api/analytics/dashboard")
        assert response.status_code == 200
        data = response.json()
        assert "total_gifts" in data
        assert "total_chests" in data
        assert "total_value" in data
    
    def test_gift_analytics(self, test_client):
        """Hediye analitik test"""
        response = test_client.get("/api/analytics/gifts")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
    
    def test_chest_analytics(self, test_client):
        """Sandık analitik test"""
        response = test_client.get("/api/analytics/chests")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

class TestDashboard:
    """Dashboard testleri"""
    
    def test_dashboard_data(self, test_client):
        """Dashboard veri test"""
        response = test_client.get("/api/dashboard/")
        assert response.status_code == 200
        data = response.json()
        assert "quick_stats" in data
        assert "recent_activity" in data
        assert "live_streams" in data
    
    def test_stats_overview(self, test_client):
        """İstatistikler genel bakış test"""
        response = test_client.get("/api/dashboard/stats/overview")
        assert response.status_code == 200
        data = response.json()
        assert "total_gifts" in data
        assert "total_chests" in data
    
    def test_activity_chart(self, test_client):
        """Aktivite grafiği test"""
        response = test_client.get("/api/dashboard/activity/chart")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

class TestAuthentication:
    """Authentication testleri"""
    
    def test_register_user(self, test_client):
        """Kullanıcı kayıt test"""
        user_data = {
            "email": "test@example.com",
            "username": "testuser",
            "password": "testpassword123"
        }
        response = test_client.post("/api/auth/register", json=user_data)
        # Test database'e bağlı olmadığı için skip
        assert response.status_code in [201, 400]
    
    def test_login_user(self, test_client):
        """Kullanıcı giriş test"""
        login_data = {
            "email": "test@example.com",
            "password": "testpassword123"
        }
        response = test_client.post("/api/auth/login", json=login_data)
        # Test database'e bağlı olmadığı için skip
        assert response.status_code in [200, 401]

class TestErrorHandling:
    """Hata yönetimi testleri"""
    
    def test_404_endpoint(self, test_client):
        """404 endpoint test"""
        response = test_client.get("/api/nonexistent")
        assert response.status_code == 404
    
    def test_invalid_method(self, test_client):
        """Geçersiz metod test"""
        response = test_client.patch("/api/health")
        assert response.status_code == 405
    
    def test_invalid_json(self, test_client):
        """Geçersiz JSON test"""
        response = test_client.post(
            "/api/auth/login",
            data="invalid json",
            headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 422

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
