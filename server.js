const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FIGMA_RELAY_API_KEY || 'change-this-key';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =============================================================================
// CLIENT & DATA MANAGEMENT
// =============================================================================

const figmaClients = new Set();

// Selection cache - stores latest selection data from Figma
// Key: clientId, Value: { timestamp, data }
const selectionCache = new Map();

// Variables cache - stores Figma Variable collections (v5.2)
// Key: clientId, Value: { timestamp, variables: [], fileKey }
const variablesCache = new Map();

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
      
      // Handle variables data from Figma (v5.2)
      if (data.type === 'variables-data') {
        variablesCache.set(clientId, {
          timestamp: Date.now(),
          variables: data.variables || [],
          fileKey: data.fileKey || null,
          fileName: data.fileName || null,
          collectionCount: data.collectionCount || 0
        });
        console.log(`Variables received from ${clientId}: ${data.variables?.length || 0} variables from ${data.collectionCount || 0} collections`);
        return;
      }
      
      // Handle analyze-frames request via WebSocket (v5.5)
      if (data.type === 'analyze-frames') {
        handleAnalyzeFramesWS(ws, data.frames || []);
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
    variablesCache.delete(clientId);
  });
  
  ws.send(JSON.stringify({ 
    type: 'connected', 
    clientId: clientId,
    message: 'Connected to Figma Relay Server v5.5' 
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

/**
 * Handle analyze-frames request via WebSocket (v5.5)
 * Calls Anthropic API and sends result back to the requesting client
 */
async function handleAnalyzeFramesWS(clientWs, frames) {
  if (!frames || frames.length === 0) {
    clientWs.send(JSON.stringify({ type: 'analyze-result', success: false, error: 'No frames provided' }));
    return;
  }
  
  if (!ANTHROPIC_API_KEY) {
    clientWs.send(JSON.stringify({ type: 'analyze-result', success: false, error: 'ANTHROPIC_API_KEY not configured' }));
    return;
  }
  
  const frameSummaries = frames.map((f, i) => {
    return `Frame ${i + 1} (id: ${f.id}, current name: "${f.name}", size: ${f.width}x${f.height}):\n${f.nodeTree}`;
  }).join('\n\n---\n\n');
  
  const systemPrompt = `You are a Figma frame naming assistant. Analyze the node tree of each frame and suggest a descriptive Korean name.

Rules:
- Format: "PageName-NN_설명" (e.g., "Onboarding-01_스크립트 설치 안내", "Dashboard-01_매출 요약 카드")
- PageName: Infer the logical page/section from content (English, PascalCase)
- NN: Sequential number starting from 01
- 설명: Brief Korean description of the frame's purpose (max 15 chars)
- If multiple frames belong to the same logical page, use the same PageName with different NN
- If you cannot determine a meaningful name, use "Unnamed-NN_프레임 설명"

Respond ONLY with a JSON array. Each element: {"frameId": "...", "suggestedName": "...", "pageName": "...", "reason": "..."}
No markdown fences, no explanation outside the JSON.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Analyze these ${frames.length} Figma frame(s) and suggest names:\n\n${frameSummaries}` }
        ]
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      clientWs.send(JSON.stringify({ type: 'analyze-result', success: false, error: `API error: ${response.status}` }));
      return;
    }
    
    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    
    let suggestions;
    try {
      suggestions = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      console.error('LLM response parse error:', text);
      clientWs.send(JSON.stringify({ type: 'analyze-result', success: false, error: 'Failed to parse LLM response' }));
      return;
    }
    
    console.log(`Frame analysis complete: ${suggestions.length} suggestions`);
    clientWs.send(JSON.stringify({ type: 'analyze-result', success: true, suggestions: suggestions }));
  } catch (err) {
    console.error('Analyze frames error:', err);
    clientWs.send(JSON.stringify({ type: 'analyze-result', success: false, error: err.message }));
  }
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Figma Relay Server v5.5 is running',
    version: '5.5',
    clients: figmaClients.size,
    features: ['bidirectional', 'selection-read', 'node-update', 'variable-sync', 'frame-naming']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '5.5', clients: figmaClients.size });
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

// -----------------------------------------------------------------------------
// GET VARIABLES - Get Figma Variable collections (v5.2)
// -----------------------------------------------------------------------------
app.get('/api/figma/variables', authMiddleware, (req, res) => {
  const allVariables = [];
  
  variablesCache.forEach((value, clientId) => {
    allVariables.push({
      clientId,
      timestamp: value.timestamp,
      age: Date.now() - value.timestamp,
      fileKey: value.fileKey,
      fileName: value.fileName,
      collectionCount: value.collectionCount,
      variables: value.variables
    });
  });
  
  if (allVariables.length === 0) {
    return res.json({
      success: true,
      message: 'No variables data available. Variables are synced automatically when Figma plugin connects.',
      variables: []
    });
  }
  
  // Return most recent
  allVariables.sort((a, b) => b.timestamp - a.timestamp);
  const latest = allVariables[0];
  
  res.json({
    success: true,
    message: 'Variables retrieved',
    fileKey: latest.fileKey,
    fileName: latest.fileName,
    collectionCount: latest.collectionCount,
    variableCount: latest.variables.length,
    variables: latest.variables,
    timestamp: latest.timestamp
  });
});

// -----------------------------------------------------------------------------
// ANALYZE FRAMES - LLM-based frame naming (v5.5)
// -----------------------------------------------------------------------------
app.post('/api/figma/analyze-frames', authMiddleware, async (req, res) => {
  const { frames } = req.body;
  
  if (!frames || !Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: 'Missing or empty frames array' });
  }
  
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }
  
  // Build frame summaries for LLM
  const frameSummaries = frames.map((f, i) => {
    return `Frame ${i + 1} (id: ${f.id}, current name: "${f.name}", size: ${f.width}x${f.height}):\n${f.nodeTree}`;
  }).join('\n\n---\n\n');
  
  const systemPrompt = `You are a Figma frame naming assistant. Analyze the node tree of each frame and suggest a descriptive Korean name.

Rules:
- Format: "PageName-NN_설명" (e.g., "Onboarding-01_스크립트 설치 안내", "Dashboard-01_매출 요약 카드")
- PageName: Infer the logical page/section from content (English, PascalCase)
- NN: Sequential number starting from 01
- 설명: Brief Korean description of the frame's purpose (max 15 chars)
- If multiple frames belong to the same logical page, use the same PageName with different NN
- If you cannot determine a meaningful name, use "Unnamed-NN_프레임 설명"

Respond ONLY with a JSON array. Each element: {"frameId": "...", "suggestedName": "...", "pageName": "...", "reason": "..."}
No markdown fences, no explanation outside the JSON.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Analyze these ${frames.length} Figma frame(s) and suggest names:\n\n${frameSummaries}` }
        ]
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: `Anthropic API error: ${response.status}` });
    }
    
    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    
    // Parse LLM response
    let suggestions;
    try {
      suggestions = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      console.error('LLM response parse error:', text);
      return res.status(502).json({ error: 'Failed to parse LLM response', raw: text });
    }
    
    res.json({
      success: true,
      suggestions: suggestions
    });
  } catch (err) {
    console.error('Analyze frames error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// START SERVER
// =============================================================================

server.listen(PORT, () => {
  console.log(`Figma Relay Server v5.5 running on port ${PORT}`);
  console.log('Features: bidirectional communication, selection reading, node updates, variable sync, frame naming');
});
