const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let config;
let openai;
let gemini;
let activeProvider = 'openai'; // Default provider

try {
  const configPath = path.join(__dirname, 'config.json');
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  // Check for OpenAI configuration
  if (config.openai && config.openai.apiKey) {
    openai = new OpenAI({ apiKey: config.openai.apiKey });
    
    // Set default OpenAI model if not specified
    if (!config.openai.model) {
      config.openai.model = "gpt-4o-mini";
      console.log("OpenAI model not specified in config, using default:", config.openai.model);
    }
    activeProvider = 'openai';
    console.log("Using OpenAI as the primary provider");
  } 
  // Check for Gemini configuration if OpenAI is not available
  else if (config.gemini && config.gemini.apiKey) {
    gemini = new GoogleGenerativeAI(config.gemini.apiKey);
    
    // Set default Gemini model if not specified
    if (!config.gemini.model) {
      config.gemini.model = "gemini-pro-vision";
      console.log("Gemini model not specified in config, using default:", config.gemini.model);
    }
    activeProvider = 'gemini';
    console.log("Using Gemini as the primary provider");
  } 
  else {
    throw new Error("No valid API configuration found. Please provide either OpenAI or Gemini API keys in config.json");
  }
} catch (err) {
  console.error("Error reading config:", err);
  app.quit();
}

let mainWindow;
let screenshots = [];
let multiPageMode = false;

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
    return { base64Image, imagePath };
  } catch (err) {
    mainWindow.show();
    if (mainWindow.webContents) {
      mainWindow.webContents.send('error', err.message);
    }
    throw err;
  }
}

async function processScreenshots() {
  try {
    if (activeProvider === 'openai') {
      await processWithOpenAI();
    } else if (activeProvider === 'gemini') {
      await processWithGemini();
    } else {
      throw new Error("No valid AI provider configured");
    }
  } catch (err) {
    console.error(`Error in processScreenshots with ${activeProvider}:`, err);
    if (mainWindow.webContents) {
      mainWindow.webContents.send('error', err.message);
    }
  }
}

async function processWithOpenAI() {
  // Build message with text + each screenshot
  const messages = [
    { type: "text", text: "Can you solve the question for me and give the final answer/code?" }
  ];
  
  for (const img of screenshots) {
    messages.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${img.base64Image}` }
    });
  }

  // Make the request
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: "user", content: messages }],
    max_tokens: 5000
  });

  // Send the text to the renderer
  mainWindow.webContents.send('analysis-result', response.choices[0].message.content);
}

async function processWithGemini() {
  try {
    const model = gemini.getGenerativeModel({ model: config.gemini.model });
    
    // Prepare prompt parts
    const promptParts = [
      { text: "Can you solve the question for me and give the final answer/code?" }
    ];
    
    // Add images to the prompt
    for (const img of screenshots) {
      const imageData = fs.readFileSync(img.imagePath);
      promptParts.push({
        inlineData: {
          data: Buffer.from(imageData).toString('base64'),
          mimeType: 'image/png'
        }
      });
    }
    
    // Generate content
    const result = await model.generateContent({
      contents: [{ role: "user", parts: promptParts }]
    });
    
    const response = result.response;
    mainWindow.webContents.send('analysis-result', response.text());
  } catch (error) {
    console.error("Gemini API error:", error);
    throw error;
  }
}

// Reset everything
function resetProcess() {
  screenshots = [];
  multiPageMode = false;
  mainWindow.webContents.send('clear-result');
  updateInstruction("Ctrl+Shift+S: Screenshot | Ctrl+Shift+A: Multi-mode");
}

function createWindow() {
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
    } catch (error) {
      console.error("Ctrl+Shift+A error:", error);
    }
  });

  // Ctrl+Shift+R => reset
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    resetProcess();
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
