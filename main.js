const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f0f0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    title: 'PodDeck — Virtual RODECaster'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Allowed store keys — prevents arbitrary writes to electron-store
const ALLOWED_STORE_KEYS = new Set(['pads', 'channels', 'master', 'recFormat']);

// IPC: Store get/set
ipcMain.handle('store-get', (event, key, defaultValue) => {
  if (typeof key !== 'string' || !ALLOWED_STORE_KEYS.has(key)) return defaultValue;
  return store.get(key, defaultValue);
});

ipcMain.handle('store-set', (event, key, value) => {
  if (typeof key !== 'string' || !ALLOWED_STORE_KEYS.has(key)) return false;
  store.set(key, value);
  return true;
});

ipcMain.handle('store-delete', (event, key) => {
  if (typeof key !== 'string' || !ALLOWED_STORE_KEYS.has(key)) return false;
  store.delete(key);
  return true;
});

// IPC: Open file dialog for audio assignment
ipcMain.handle('open-audio-file', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Assign Audio File',
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// IPC: Save recording dialog
ipcMain.handle('save-recording', async (event) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Recording',
    defaultPath: `podcast-${Date.now()}.wav`,
    filters: [
      { name: 'WAV Audio', extensions: ['wav'] },
      { name: 'MP3 Audio', extensions: ['mp3'] }
    ]
  });
  if (result.canceled) return null;
  return result.filePath;
});
