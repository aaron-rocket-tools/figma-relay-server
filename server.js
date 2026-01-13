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

// =============================================================================
// CLIENT & DATA MANAGEMENT
// =============================================================================

const figmaClients = new Set();

// Selection cache - stores latest selection data from Figma
// Key: clientId, Value: { timestamp, data }
const selectionCache = new Map();

// Pending requests waiting for Figma response
// Key: requestId, Value: { resolve, reject, timeout }
const pendingRequests = new Map();

// Request timeout (30 seconds)
const REQUEST_TIMEOUT = 30000;

// Generate unique request ID
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// =============================================================================
// WEBSOCKET HANDLING
// =============================================================================

wss.on('connection', (ws) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  ws.clientId = clientId;
  
  console.log(`Figma plugin connected: ${clientId}`);
  figmaClients.add(ws);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle ping/pong for keep-alive
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      
      // Handle selection data from Figma
      if (data.type === 'selection-data') {
        selectionCache.set(clientId, {
          timestamp: Date.now(),
          data: data.selection,
          nodeCount: data.nodeCount || 0
        });
        console.log(`Selection received from ${clientId}: ${data.nodeCount || 0} nodes`);
        
        // If this was a response to a pending request, resolve it
        if (data.requestId && pendingRequests.has(data.requestId)) {
          const pending = pendingRequests.get(data.requestId);
          clearTimeout(pending.timeout);
          pending.resolve(data);
          pendingRequests.delete(data.requestId);
        }
        return;
      }
      
      // Handle operation results from Figma
      if (data.type === 'operation-result') {
        if (data.requestId && pendingRequests.has(data.requestId)) {
          const pending = pendingRequests.get(data.requestId);
          clearTimeout(pending.timeout);
          if (data.success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(data.error || 'Operation failed'));
          }
          pendingRequests.delete(data.requestId);
        }
        return;
      }
      
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });
  
  ws.on('close', () => {
    console.log(`Figma plugin disconnected: ${clientId}`);
    figmaClients.delete(ws);
    selectionCache.delete(clientId);
  });
  
  ws.send(JSON.stringify({ 
    type: 'connected', 
    clientId: clientId,
    message: 'Connected to Figma Relay Server v3.0' 
  }));
});

// =============================================================================
// MIDDLEWARE
// =============================================================================

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

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Send message to all connected Figma clients
 */
function broadcastToFigma(message) {
  let sentCount = 0;
  const messageStr = JSON.stringify(message);
  
  figmaClients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(messageStr);
      sentCount++;
    }
  });
  
  return sentCount;
}

/**
 * Send message and wait for response
 */
function sendAndWait(message, timeoutMs = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    message.requestId = requestId;
    
    const sentCount = broadcastToFigma(message);
    
    if (sentCount === 0) {
      reject(new Error('No Figma clients connected'));
      return;
    }
    
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, timeoutMs);
    
    pendingRequests.set(requestId, { resolve, reject, timeout });
  });
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Figma Relay Server v3.0 is running',
    version: '3.0',
    clients: figmaClients.size,
    features: ['bidirectional', 'selection-read', 'node-update']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0', clients: figmaClients.size });
});

// -----------------------------------------------------------------------------
// CREATE - Send new UI spec to Figma (existing functionality)
// -----------------------------------------------------------------------------
app.post('/api/figma/create', authMiddleware, (req, res) => {
  const spec = req.body;
  
  if (!spec || !spec.type) {
    return res.status(400).json({ error: 'Invalid spec: missing type' });
  }
  
  const sentCount = broadcastToFigma({
    type: 'create',
    spec: spec,
    timestamp: Date.now()
  });
  
  res.json({
    success: true,
    message: 'Spec sent to Figma',
    clientCount: sentCount
  });
});

// -----------------------------------------------------------------------------
// READ SELECTION - Get current selection from Figma (cached)
// -----------------------------------------------------------------------------
app.get('/api/figma/selection', authMiddleware, (req, res) => {
  // Return cached selection data
  const selections = [];
  
  selectionCache.forEach((value, clientId) => {
    selections.push({
      clientId,
      timestamp: value.timestamp,
      age: Date.now() - value.timestamp,
      nodeCount: value.nodeCount,
      data: value.data
    });
  });
  
  if (selections.length === 0) {
    return res.json({
      success: true,
      message: 'No selection data available. Click "Send Selection" in Figma plugin.',
      selections: []
    });
  }
  
  // Return most recent selection
  selections.sort((a, b) => b.timestamp - a.timestamp);
  
  res.json({
    success: true,
    message: 'Selection data retrieved',
    latest: selections[0],
    all: selections
  });
});

// -----------------------------------------------------------------------------
// REQUEST SELECTION - Ask Figma to send current selection (async)
// -----------------------------------------------------------------------------
app.post('/api/figma/request-selection', authMiddleware, async (req, res) => {
  try {
    const result = await sendAndWait({
      type: 'read-selection',
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      message: 'Selection retrieved',
      data: result
    });
  } catch (err) {
    res.status(504).json({
      success: false,
      error: err.message
    });
  }
});

// -----------------------------------------------------------------------------
// UPDATE NODE - Update specific node by ID
// -----------------------------------------------------------------------------
app.post('/api/figma/update', authMiddleware, async (req, res) => {
  const { targetId, updates } = req.body;
  
  if (!targetId) {
    return res.status(400).json({ error: 'Missing targetId' });
  }
  
  if (!updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Missing updates' });
  }
  
  try {
    const result = await sendAndWait({
      type: 'update-node',
      targetId,
      updates,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      message: 'Node updated',
      result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// -----------------------------------------------------------------------------
// REPLACE CHILDREN - Replace child at specific index
// -----------------------------------------------------------------------------
app.post('/api/figma/replace-child', authMiddleware, async (req, res) => {
  const { targetId, childIndex, newChild } = req.body;
  
  if (!targetId) {
    return res.status(400).json({ error: 'Missing targetId' });
  }
  
  if (childIndex === undefined) {
    return res.status(400).json({ error: 'Missing childIndex' });
  }
  
  if (!newChild) {
    return res.status(400).json({ error: 'Missing newChild spec' });
  }
  
  try {
    const result = await sendAndWait({
      type: 'replace-child',
      targetId,
      childIndex,
      newChild,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      message: 'Child replaced',
      result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// -----------------------------------------------------------------------------
// INSERT CHILD - Insert new child at specific index
// -----------------------------------------------------------------------------
app.post('/api/figma/insert-child', authMiddleware, async (req, res) => {
  const { targetId, childIndex, newChild } = req.body;
  
  if (!targetId) {
    return res.status(400).json({ error: 'Missing targetId' });
  }
  
  if (!newChild) {
    return res.status(400).json({ error: 'Missing newChild spec' });
  }
  
  try {
    const result = await sendAndWait({
      type: 'insert-child',
      targetId,
      childIndex: childIndex !== undefined ? childIndex : -1, // -1 = append
      newChild,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      message: 'Child inserted',
      result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// -----------------------------------------------------------------------------
// DELETE NODE - Remove node by ID
// -----------------------------------------------------------------------------
app.post('/api/figma/delete', authMiddleware, async (req, res) => {
  const { targetId } = req.body;
  
  if (!targetId) {
    return res.status(400).json({ error: 'Missing targetId' });
  }
  
  try {
    const result = await sendAndWait({
      type: 'delete-node',
      targetId,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      message: 'Node deleted',
      result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =============================================================================
// START SERVER
// =============================================================================

server.listen(PORT, () => {
  console.log(`Figma Relay Server v3.0 running on port ${PORT}`);
  console.log('Features: bidirectional communication, selection reading, node updates');
});
