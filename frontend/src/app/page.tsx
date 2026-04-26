"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { 
  ChartBarIcon, 
  PlayIcon, 
  GiftIcon, 
  UserGroupIcon,
  SparklesIcon,
  RocketLaunchIcon
} from "@heroicons/react/24/outline";
import toast from "react-hot-toast";

export default function HomePage() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeUsers, setActiveUsers] = useState(0);
  const [liveStreams, setLiveStreams] = useState(0);
  const [totalGifts, setTotalGifts] = useState(0);

  useEffect(() => {
    // WebSocket bağlantısı
    const ws = new WebSocket("ws://localhost:8000/ws/demo-user");
    
    ws.onopen = () => {
      setIsConnected(true);
      toast.success("🚀 TikTok Panel'e bağlandı!");
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("WebSocket mesajı:", data);
    };
    
    ws.onclose = () => {
      setIsConnected(false);
      toast.error("❌ Bağlantı kesildi");
    };
    
    return () => {
      ws.close();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* Header */}
      <header className="border-b border-white/10 backdrop-blur-lg bg-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg flex items-center justify-center">
                <SparklesIcon className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-white">TikTok Panel</h1>
            </div>
            
            <div className="flex items-center space-x-4">
              <div className={`flex items-center space-x-2 px-3 py-1 rounded-full ${
                isConnected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}>
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'} animate-pulse`} />
                <span className="text-sm font-medium">
                  {isConnected ? 'Bağlı' : 'Bağlantı Yok'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center"
          >
            <h2 className="text-5xl sm:text-6xl font-bold text-white mb-6">
              TikTok Jeton
              <span className="bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                {" "}Yönetim Paneli
              </span>
            </h2>
            <p className="text-xl text-gray-300 mb-8 max-w-3xl mx-auto">
              Canlı yayın takibi, otomatik sandık yakalama ve gelişmiş analitik özellikleriyle 
              TikTok hesabınızı profesyonel şekilde yönetin.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="px-8 py-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold rounded-lg hover:shadow-lg hover:shadow-purple-500/25 transition-all duration-200"
              >
                <RocketLaunchIcon className="w-5 h-5 inline-block mr-2" />
                Hemen Başla
              </motion.button>
              
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="px-8 py-3 bg-white/10 backdrop-blur-sm text-white font-semibold rounded-lg border border-white/20 hover:bg-white/20 transition-all duration-200"
              >
                Dokümantasyon
              </motion.button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h3 className="text-3xl font-bold text-white mb-4">
              Özellikler
            </h3>
            <p className="text-gray-400 max-w-2xl mx-auto">
              TikTok Panel'in sunduğu güçlü özelliklerle hesabınızı bir üst seviyeye taşıyın.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-all duration-300"
            >
              <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-lg flex items-center justify-center mb-4">
                <PlayIcon className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-semibold text-white mb-2">
                Canlı Yayın Takibi
              </h4>
              <p className="text-gray-400">
                100+ canlı yayını aynı anda izleyin, anlık bildirimler alın.
              </p>
            </motion.div>

            {/* Feature 2 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-all duration-300"
            >
              <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg flex items-center justify-center mb-4">
                <GiftIcon className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-semibold text-white mb-2">
                Otomatik Sandık Yakalama
              </h4>
              <p className="text-gray-400">
                Sandıkları otomatik tespit edin, fırsatları kaçırmayın.
              </p>
            </motion.div>

            {/* Feature 3 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-all duration-300"
            >
              <div className="w-12 h-12 bg-gradient-to-r from-green-500 to-emerald-500 rounded-lg flex items-center justify-center mb-4">
                <ChartBarIcon className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-semibold text-white mb-2">
                Real-time Analitik
              </h4>
              <p className="text-gray-400">
                Detaylı grafikler ve istatistiklerle performansınızı analiz edin.
              </p>
            </motion.div>

            {/* Feature 4 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-all duration-300"
            >
              <div className="w-12 h-12 bg-gradient-to-r from-orange-500 to-red-500 rounded-lg flex items-center justify-center mb-4">
                <UserGroupIcon className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-semibold text-white mb-2">
                Çoklu Hesap Yönetimi
              </h4>
              <p className="text-gray-400">
                Birden fazla TikTok hesabınızı tek bir panelden yönetin.
              </p>
            </motion.div>

            {/* Feature 5 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-all duration-300"
            >
              <div className="w-12 h-12 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-lg flex items-center justify-center mb-4">
                <SparklesIcon className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-semibold text-white mb-2">
                AI Destekli Stratejiler
              </h4>
              <p className="text-gray-400">
                Yapay zeka ile en iyi stratejileri otomatik olarak belirleyin.
              </p>
            </motion.div>

            {/* Feature 6 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-all duration-300"
            >
              <div className="w-12 h-12 bg-gradient-to-r from-teal-500 to-cyan-500 rounded-lg flex items-center justify-center mb-4">
                <RocketLaunchIcon className="w-6 h-6 text-white" />
              </div>
              <h4 className="text-xl font-semibold text-white mb-2">
                Hız ve Performans
              </h4>
              <p className="text-gray-400">
                200ms'den daha hızlı response time ile kesintisiz deneyim.
              </p>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-20 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-4xl font-bold text-white mb-2">
                {activeUsers}+
              </div>
              <div className="text-gray-400">
                Aktif Kullanıcı
              </div>
            </div>
            <div>
              <div className="text-4xl font-bold text-white mb-2">
                {liveStreams}
              </div>
              <div className="text-gray-400">
                Canlı Yayın
              </div>
            </div>
            <div>
              <div className="text-4xl font-bold text-white mb-2">
                {totalGifts}K+
              </div>
              <div className="text-gray-400">
                İşlem Hacmi
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-gray-400">
              © 2024 TikTok Panel. Tamamen ücretsiz ve açık kaynak.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
