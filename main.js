// Load Electron API with compatibility for export-map changes across versions
const electronNS = require('electron');
const app = electronNS.app || electronNS.default?.app;
const BrowserWindow = electronNS.BrowserWindow || electronNS.default?.BrowserWindow;
const ipcMain = electronNS.ipcMain || electronNS.default?.ipcMain;
const protocol = electronNS.protocol || electronNS.default?.protocol;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Register custom protocol when supported (Electron versions without registerSchemesAsPrivileged fall back to file://)
const supportsCustomProtocol = typeof protocol?.registerSchemesAsPrivileged === 'function';
if (supportsCustomProtocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'lively-app', privileges: { secure: true, standard: true, supportFetchAPI: true } }
  ]);
}

let mainWindow;

function getTrackInfo() {
  // Path to the C# helper tool, adjusted for production
  const isDev = !app.isPackaged;
  const toolDir = isDev
    ? path.join(__dirname, 'NowPlayingTool', 'bin', 'Release')
    : path.join(process.resourcesPath, 'NowPlayingTool');
  
  const toolPath = path.join(toolDir, 'NowPlayingTool.exe');
  const child = spawn(toolPath);

  let stdout = '';
  child.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  child.on('close', (code) => {
    if (code === 0) {
      if (stdout) {
        try {
          // The C# tool outputs a JSON string, which we send directly.
          // The original livelyCurrentTrack function expects a string.
          mainWindow?.webContents.send('track-info', stdout);
        } catch (e) {
          console.error('Error processing track info:', e);
          mainWindow?.webContents.send('track-info', null);
        }
      } else {
        // Send null when no music is playing
        mainWindow?.webContents.send('track-info', null);
      }
    }
  });

  child.on('error', (err) => {
    console.error('Failed to start NowPlayingTool:', err);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    transparent: true, // Enable transparency
    frame: false,      // Hide window frame for overlay effect
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Required for preload script to work
      contextIsolation: true,
      // Allow renderer to access local http server
      webSecurity: false,
      // Keep animations running even when window is not in focus
      backgroundThrottling: false
    }
  });

  // Load the app using custom protocol if supported; otherwise load from file system
  if (supportsCustomProtocol) {
    mainWindow.loadURL('lively-app://index.html');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }

  // --- IPC Handlers for Custom Window Controls ---
  ipcMain.on('minimize-window', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('maximize-window', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow?.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('close-window', () => {
    mainWindow?.close();
  });

  ipcMain.on('toggle-devtools', () => {
    mainWindow?.webContents.toggleDevTools();
  });

  ipcMain.on('renderer-log', (_event, payload) => {
    try {
      const { level, args } = payload || {};
      const prefix = `[renderer:${level || 'log'}]`;
      if (level === 'error') console.error(prefix, ...(args || []));
      else if (level === 'warn') console.warn(prefix, ...(args || []));
      else console.log(prefix, ...(args || []));
      try {
        const logDir = app.getPath('userData');
        const logFile = path.join(logDir, 'app.log');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const line = `[${new Date().toISOString()}] [renderer:${level || 'log'}] ${args.map(a => {
          try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
        }).join(' ')}\n`;
        fs.appendFileSync(logFile, line);
      } catch {}
    } catch (e) {
      console.log('[renderer:log] (malformed payload)');
    }
  });

  // Save file from renderer (relative to app directory)
  ipcMain.on('save-file', (_event, payload) => {
    try {
      const { relativePath, data } = payload || {};
      if (!relativePath || !data) return;
      // Resolve to app directory; prevent writing outside
      const targetPath = path.resolve(__dirname, relativePath);
      if (!targetPath.startsWith(path.resolve(__dirname))) {
        console.error('Refusing to write outside app directory:', targetPath);
        return;
      }
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const buffer = Buffer.from(Uint8Array.from(data));
      fs.writeFileSync(targetPath, buffer);
      console.log('Saved file:', targetPath);
    } catch (e) {
      console.error('save-file error:', e);
    }
  });

  // Config persistence in userData
  ipcMain.handle('load-config', async () => {
    try {
      const cfgDir = app.getPath('userData');
      const cfgPath = path.join(cfgDir, 'profile.json');
      if (!fs.existsSync(cfgPath)) return {};
      const raw = fs.readFileSync(cfgPath, 'utf-8');
      return JSON.parse(raw || '{}');
    } catch (e) {
      console.warn('load-config failed:', e?.message || e);
      return {};
    }
  });

  ipcMain.handle('save-config', async (_event, data) => {
    try {
      const cfgDir = app.getPath('userData');
      const cfgPath = path.join(cfgDir, 'profile.json');
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(data || {}, null, 2), 'utf-8');
      return { ok: true };
    } catch (e) {
      console.warn('save-config failed:', e?.message || e);
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Provide model listing to renderer
  ipcMain.handle('list-models', async () => {
    try {
      const modelsDir = path.join(__dirname, 'models');
      if (!fs.existsSync(modelsDir)) return [];
      const files = fs.readdirSync(modelsDir).filter(f => f.toLowerCase().endsWith('.glb')).sort();
      return files.map(f => ({ name: f, path: 'models/' + f }));
    } catch (e) {
      return [];
    }
  });

  // Handle permission requests for media (webcam, microphone, screen audio)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    // Include 'display-capture' to allow getDisplayMedia for system audio capture
    const allowedPermissions = ['media', 'camera', 'microphone', 'display-capture'];
    if (allowedPermissions.includes(permission)) {
      // Automatically grant permission for media, camera, and microphone
      callback(true);
    } else {
      // Deny other permissions
      callback(false);
    }
  });
}

app.whenReady().then(async () => {
  // Redirect userData to a writable temp subfolder to avoid cache permission issues
  try {
    const userDataBase = app.getPath('temp');
    const userDataPath = path.join(userDataBase, 'LivingRoomUserData');
    app.setPath('userData', userDataPath);
  } catch (e) {
    console.warn('Could not set userData path:', e);
  }
  // Simple persistent logger
  const logDir = app.getPath('userData');
  const logFile = path.join(logDir, 'app.log');
  function appendLog(level, ...args) {
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
      }).join(' ')}\n`;
      fs.appendFileSync(logFile, line);
    } catch {}
  }
  // Startup marker with version + environment
  try {
    appendLog('info', 'startup', 'appVersion', app.getVersion(), 'electron', process.versions.electron, 'node', process.versions.node, 'chrome', process.versions.chrome, 'dir', __dirname, 'customProtocol', String(supportsCustomProtocol));
  } catch {}
  // Implement the custom protocol handler (only when custom protocol is supported)
  if (supportsCustomProtocol) protocol.registerBufferProtocol('lively-app', (request, callback) => {
    const url = new URL(request.url);
    let filePath = path.join(__dirname, url.pathname);

    if (url.pathname === '/') {
      filePath = path.join(__dirname, 'index.html');
    }

    fs.readFile(filePath, (err, buffer) => {
      if (err) {
        console.error(`[protocol] Failed to read: ${filePath}`, err?.message || err);
        appendLog('error', '[protocol] read fail', filePath, err?.message || String(err));
        callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
        return;
      }
      
      const extension = path.extname(filePath).toLowerCase();
      let mimeType = 'application/octet-stream';
      if (extension === '.html') mimeType = 'text/html';
      else if (extension === '.js') mimeType = 'text/javascript';
      else if (extension === '.css') mimeType = 'text/css';
      else if (extension === '.json') mimeType = 'application/json';
      else if (extension === '.png') mimeType = 'image/png';
      else if (extension === '.jpg' || extension === '.jpeg') mimeType = 'image/jpeg';
      else if (extension === '.glb') mimeType = 'model/gltf-binary';
      else if (extension === '.webm') mimeType = 'video/webm';
      else if (extension === '.ttf') mimeType = 'font/ttf';

      if (mimeType === 'model/gltf-binary') {
        console.log(`[protocol] Serve GLB: ${filePath} (${buffer.length} bytes)`);
        appendLog('info', '[protocol] serve glb', filePath, buffer.length + ' bytes');
      }
      callback({ mimeType, data: buffer });
    });
  });

  // Version/info for renderer
  ipcMain.handle('get-version', async () => {
    try {
      return {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        dir: __dirname,
        customProtocol: !!supportsCustomProtocol
      };
    } catch (e) {
      return { appVersion: 'unknown' };
    }
  });

  // Ensure default models exist: stay offline-friendly and just log if missing
  try {
    const modelsDir = path.join(__dirname, 'models');
    const housePath = path.join(modelsDir, 'House.glb');
    if (!fs.existsSync(housePath)) {
      appendLog('warn', 'House.glb missing', housePath);
    }
  } catch (e) {
    appendLog('warn', 'Models check failed', e?.message || String(e));
  }

  createWindow();

  // Start polling for track info
  setInterval(getTrackInfo, 5000); // Check every 5 seconds

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
