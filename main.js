const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const { OpenAI } = require('openai');

let config;
try {
  const configPath = path.join(__dirname, 'config.json');
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  if (!config.apiKey) {
    throw new Error("API key is missing in config.json");
  }
  
  // Set default model if not specified
  if (!config.model) {
    config.model = "gpt-4o-mini";
    console.log("Model not specified in config, using default:", config.model);
  }
} catch (err) {
  console.error("Error reading config:", err);
  app.quit();
}
const openai = new OpenAI({ apiKey: config.apiKey });

let mainWindow;
let screenshots = [];
let multiPageMode = false;
let showWindow = true;
let stage = 0; // 0 = boot up stage, 1 = multi capture, 2 = AI Answered

function updateInstruction(instruction) {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('update-instruction', instruction);
  }
}

function hideInstruction() {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('hide-instruction');
  }
}

async function captureScreenshot() {
  try {
    hideInstruction();
    mainWindow.hide();
    await new Promise(res => setTimeout(res, 200));

    const timestamp = Date.now();
    const imagePath = path.join(app.getPath('pictures'), `screenshot_${timestamp}.png`);
    await screenshot({ filename: imagePath });

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    mainWindow.show();
    return base64Image;
  } catch (err) {
    mainWindow.show();
    if (mainWindow.webContents) {
      mainWindow.webContents.send('error', err.message);
    }
    throw err;
  }
}

function showMainWindow() {
  mainWindow.show();
  if (stage == 2)
    mainWindow.webContents.send('show-app');
  else
    updateInstruction();
  showWindow = true;
}

function hideMainWindow() {
  mainWindow.webContents.send('hide-app');
  mainWindow.hide();
  showWindow = false;
}

async function processScreenshots() {
  try {
    // Build message with text + each screenshot
    const messages = [
      { type: "text", text: "Can you solve the question for me and give the final answer/code?" }
    ];
    for (const img of screenshots) {
      messages.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${img}` }
      });
    }

    // Make the request
    const response = await openai.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: messages }],
      max_tokens: 5000
    });

    // Send the text to the renderer
    mainWindow.webContents.send('analysis-result', response.choices[0].message.content);
    
    // // Create mock data for the response
    // const mockResponse = {
    //   choices: [
    //       {
    //           message: {
    //               content: "This is the mocked response from the AI."
    //           }
    //       }
    //   ]
    // };

    // // Simulate receiving the response
    // const response = mockResponse;

    // Send the text to the renderer
    mainWindow.webContents.send('analysis-result', response.choices[0].message.content);
    stage = 2;
  } catch (err) {
    console.error("Error in processScreenshots:", err);
    if (mainWindow.webContents) {
      mainWindow.webContents.send('error', err.message);
    }
  }
}

// Reset everything
function resetProcess() {
  screenshots = [];
  multiPageMode = false;
  mainWindow.webContents.send('clear-result');
  updateInstruction("Ctrl+Shift+S: Screenshot | Ctrl+Shift+A: Multi-mode | Ctrl+Shift+W: Hide Window | Ctrl+Shift+Q: Close");
  stage = 0;
}

function createWindow() {
  stage = 0;
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    paintWhenInitiallyHidden: true,
    contentProtection: true,
    type: 'toolbar',
  });

  mainWindow.loadFile('index.html');
  mainWindow.setContentProtection(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  // Ctrl+Shift+S => single or final screenshot
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    try {
      const img = await captureScreenshot();
      screenshots.push(img);
      await processScreenshots();
    } catch (error) {
      console.error("Ctrl+Shift+S error:", error);
    }
  });

  // Ctrl+Shift+A => multi-page mode
  globalShortcut.register('CommandOrControl+Shift+A', async () => {
    try {
      if (!multiPageMode) {
        multiPageMode = true;
        updateInstruction("Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+S to finalize");
      }
      const img = await captureScreenshot();
      screenshots.push(img);
      updateInstruction("Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+S to finalize");
      stage = 1;
    } catch (error) {
      console.error("Ctrl+Shift+A error:", error);
    }
  });

  // Ctrl+Shift+R => reset
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    resetProcess();
  });

  // Ctrl+Shift+W => Hide app
  globalShortcut.register('CommandOrControl+Shift+W', () => {
    if (showWindow)
    {
      hideMainWindow();
    }
    else
    {
      showMainWindow();
    }
  });
     
  // Ctrl+Shift+Q => Quit the application
globalShortcut.register('CommandOrControl+Shift+Q', () => {
  console.log("Quitting application...");
  app.quit();
  
});
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
