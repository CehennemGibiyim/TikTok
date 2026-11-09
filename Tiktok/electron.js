const { app, BrowserWindow } = require('electron');
const path = require('path');

// Masaüstü uygulaması açılırken arka planda bot ve radar sunucusunu (WebSocket) otomatik başlat
require('./server.js');

function createWindow () {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    autoHideMenuBar: true,
    title: "TikTok Sandık Radarı PRO"
  });

  // Arayüzü direkt olarak electron içinde aç
  win.loadFile('index.html');
  
  // İsteğe bağlı: Geliştirici araçlarını açmak isterseniz
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Tüm pencereler kapatıldığında uygulamayı ve arka plan Node.js sunucusunu tamamen kapat
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    process.exit(0);
  }
});
