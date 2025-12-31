const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FIGMA_RELAY_API_KEY || 'change-this-key';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const figmaClients = new Set();

wss.on('connection', (ws) => {
  console.log('Figma plugin connected');
  figmaClients.add(ws);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });
  
  ws.on('close', () => {
    console.log('Figma plugin disconnected');
    figmaClients.delete(ws);
  });
  
  ws.send(JSON.stringify({ 
    type: 'connected', 
    message: 'Connected to Figma Relay Server' 
  }));
});

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  if (authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

app.get('/', (req, res) => {
  res.json({ 
    status: 'Figma Relay Server is running',
    clients: figmaClients.size
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', clients: figmaClients.size });
});

app.post('/api/figma/create', authMiddleware, (req, res) => {
  const spec = req.body;
  
  if (!spec || !spec.type) {
    return res.status(400).json({ error: 'Invalid spec' });
  }
  
  const message = JSON.stringify({
    type: 'create',
    spec: spec,
    timestamp: Date.now()
  });
  
  let sentCount = 0;
  figmaClients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
      sentCount++;
    }
  });
  
  res.json({
    success: true,
    message: 'Spec sent to Figma',
    clientCount: sentCount
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
