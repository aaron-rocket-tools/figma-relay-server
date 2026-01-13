# Figma Relay Server v3.0

WebSocket relay server for bidirectional communication between Claude and Figma.

## New in v3.0

- **Bidirectional Communication**: Read designs from Figma, not just write
- **Selection Caching**: Store selection data from Figma clients
- **Request/Response Pattern**: Wait for Figma plugin responses
- **Node Update APIs**: Update, replace, insert, delete nodes

## API Endpoints

### Health & Status

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | No | Server status and connected client count |
| `/health` | GET | No | Health check |

### Create (existing)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/figma/create` | POST | Yes | Send new UI spec to Figma |

### Read (NEW)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/figma/selection` | GET | Yes | Get cached selection data |
| `/api/figma/request-selection` | POST | Yes | Request fresh selection (async) |

### Update (NEW)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/figma/update` | POST | Yes | Update node properties by ID |
| `/api/figma/replace-child` | POST | Yes | Replace child at index |
| `/api/figma/insert-child` | POST | Yes | Insert new child at index |
| `/api/figma/delete` | POST | Yes | Delete node by ID |

## Request Examples

### Get Selection
```bash
curl -X GET \
  https://your-server.railway.app/api/figma/selection \
  -H "Authorization: Bearer your-api-key"
```

### Update Node
```bash
curl -X POST \
  https://your-server.railway.app/api/figma/update \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "123:456",
    "updates": {
      "characters": "New Text",
      "fontSize": 24
    }
  }'
```

### Replace Child
```bash
curl -X POST \
  https://your-server.railway.app/api/figma/replace-child \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "123:456",
    "childIndex": 0,
    "newChild": {
      "$": "Button",
      "label": "Click Me",
      "variant": "primary"
    }
  }'
```

### Insert Child
```bash
curl -X POST \
  https://your-server.railway.app/api/figma/insert-child \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "123:456",
    "childIndex": -1,
    "newChild": {
      "$": "Badge",
      "label": "NEW"
    }
  }'
```

### Delete Node
```bash
curl -X POST \
  https://your-server.railway.app/api/figma/delete \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "123:458"
  }'
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `FIGMA_RELAY_API_KEY` | API key for authentication | change-this-key |

## Deployment

### Railway

```bash
cd relay-server
railway login
railway init
railway up
```

Set environment variables in Railway dashboard:
- `FIGMA_RELAY_API_KEY`: Your secure API key

### Local Development

```bash
npm install
PORT=3000 FIGMA_RELAY_API_KEY=dev-key node server.js
```

## WebSocket Protocol

### Messages from Server to Plugin

```json
{"type": "connected", "clientId": "client_xxx", "message": "..."}
{"type": "create", "spec": {...}, "timestamp": 123}
{"type": "read-selection", "requestId": "req_xxx"}
{"type": "update-node", "targetId": "123:456", "updates": {...}, "requestId": "req_xxx"}
{"type": "replace-child", "targetId": "123:456", "childIndex": 0, "newChild": {...}, "requestId": "req_xxx"}
{"type": "insert-child", "targetId": "123:456", "childIndex": -1, "newChild": {...}, "requestId": "req_xxx"}
{"type": "delete-node", "targetId": "123:456", "requestId": "req_xxx"}
```

### Messages from Plugin to Server

```json
{"type": "ping"}
{"type": "selection-data", "selection": {...}, "nodeCount": 1, "requestId": "req_xxx"}
{"type": "operation-result", "requestId": "req_xxx", "success": true, ...}
```

## Architecture

```
Claude ◄─────► Relay Server ◄─────► Figma Plugin
       HTTP           WebSocket (bidirectional)
```

The relay server:
1. Receives HTTP requests from Claude
2. Broadcasts/forwards to connected Figma plugins via WebSocket
3. Caches selection data from plugins
4. Waits for operation results with timeout handling
