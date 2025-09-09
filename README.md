# RadioDock Metadata Proxy

A production-ready metadata proxy server that handles "Now Playing" data fetching for the RadioDock Chrome extension. This proxy enables the extension to restrict its host permissions while maintaining full metadata functionality for all supported radio stations.

## Overview

The proxy server centralizes all metadata fetching logic that was previously handled client-side in the extension, except for HLS streams which continue to use local hls.js ID3 processing. This architecture provides:

- **Security**: Reduced extension host permissions to only Radio Browser API and this proxy
- **Maintainability**: Server-side rule updates without requiring store updates
- **Performance**: Caching, rate limiting, and optimized concurrent fetching
- **Reliability**: Robust error handling, timeouts, and graceful degradation

## API Endpoints

### `GET /v1/metadata`

Fetch "Now Playing" metadata for a radio stream.

**Query Parameters:**
- `url` (required): Stream URL to fetch metadata for
- `stationId` (optional): Station ID from Radio Browser
- `homepage` (optional): Station homepage URL  
- `country` (optional): Station country code

**Example Request:**
```
GET /v1/metadata?url=https://stream.example.com/radio&stationId=12345&country=US
```

**Success Response (200):**
```json
{
  "ok": true,
  "stationId": "12345",
  "streamUrl": "https://stream.example.com/radio",
  "source": "icy",
  "artist": "Artist Name",
  "title": "Song Title", 
  "display": "Artist Name - Song Title",
  "raw": { "streamTitle": "Artist Name - Song Title" },
  "fetchedAt": 1736100000000,
  "cacheTtl": 15
}
```

**Error Response (200):**
```json
{
  "ok": false,
  "stationId": "12345",
  "streamUrl": "https://stream.example.com/radio",
  "reason": "no-metadata",
  "message": "No metadata available for this stream",
  "fetchedAt": 1736100000000,
  "cacheTtl": 10
}
```

**Error Reasons:**
- `invalid-url`: Invalid or malformed stream URL
- `no-metadata`: No metadata found from any source
- `timeout`: Request timed out
- `blocked`: Request blocked by rate limiting
- `hls-client`: HLS stream should be handled client-side
- `upstream-error`: Error from upstream metadata sources
- `server-error`: Internal server error

### `GET /health`

Health check endpoint for monitoring and load balancers.

**Response:**
```json
{
  "status": "ok"
}
```

## Supported Metadata Sources

The proxy implements all metadata strategies from the original extension:

1. **ICY Metadata** - Stream metadata blocks with Icy-MetaData headers
2. **Icecast Status** - JSON status endpoints (status-json.xsl, status.json, etc.)
3. **NTS Radio API** - Live channel metadata from nts.live
4. **Airtime Pro** - Generic Airtime Pro stations using live-info-v2 API
5. **Cashmere Radio** - Specific Airtime Pro instance
6. **Radio King** - radioking.com API endpoints
7. **Callshop Radio** - Custom JSON status endpoint  
8. **Generic APIs** - Common station API patterns
9. **Radio Browser** - Fallback using radio-browser.info data
10. **Station Info** - Last resort using station name/info

**HLS Exclusion:** URLs containing `.m3u8` return `{ok: false, reason: "hls-client"}` to ensure local processing.

## Development

### Prerequisites
- Node.js 18+ 
- npm

### Setup
```bash
cd proxy
npm install
npm run dev
```

The server will start on `http://localhost:3000` in development mode.

### Environment Variables
- `PORT`: Server port (default: 3000)
- `LOG_LEVEL`: Logging level (default: info)

### Testing
Test the metadata endpoint:
```bash
curl "http://localhost:3000/v1/metadata?url=https://stream.example.com/radio"
```

Test health endpoint:
```bash
curl http://localhost:3000/health
```

## Production Deployment

### Render.com (Recommended)

1. **Create new Web Service** on Render.com
2. **Connect Repository** containing this proxy code
3. **Configure Service:**
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Auto-Deploy: Yes

4. **Environment Variables:**
   - `NODE_ENV=production`
   - `LOG_LEVEL=info`

5. **Health Check:** `/health`

The service will be available at `https://your-service.onrender.com`

### Alternative Deployments

**Heroku:**
```bash
heroku create radiodock-metadata-proxy
git push heroku main
```

**Railway:**
```bash
railway login
railway new
railway up
```

**Docker:**
```bash
docker build -t radiodock-proxy .
docker run -p 3000:3000 radiodock-proxy
```

## Configuration

### Rate Limiting
- **Window:** 60 seconds
- **Max Requests:** 120 per IP per window
- **Storage:** In-memory (resets on restart)

### Caching
- **Type:** LRU cache
- **Max Items:** 1000
- **Default TTL:** 15 seconds
- **Strategy Override:** Some sources specify custom TTL

### Timeouts
- **Default:** 8 seconds
- **Fast Endpoints:** 3.5 seconds  
- **Health Check:** 5 seconds

### CORS
- **Extension Origins:** `chrome-extension://*`, `moz-extension://*`
- **Development:** `localhost:3000`, `127.0.0.1:3000`
- **Methods:** GET, HEAD
- **Credentials:** False

## Monitoring

### Logs
The server uses structured logging with pino. Key log events:
- Request/response cycles with duration
- Metadata fetch successes and failures
- Rate limiting events
- Health check requests

### Metrics
Monitor these endpoints for service health:
- `GET /health` - Service availability
- Request/response times
- Error rates by source type
- Cache hit/miss ratios

### Alerts
Recommended monitoring:
- Response time > 5 seconds
- Error rate > 10%
- Health check failures
- Memory usage > 80%

## Security

### Input Validation
- URL format and scheme validation (http/https only)
- Parameter length limits
- No open proxy behavior

### Request Limits
- 10-second maximum request timeout
- Rate limiting per IP address
- Request size limits (1MB max)

### CORS Policy
- Restricted to extension origins
- No wildcard origins in production
- Explicit header allowlist

## Troubleshooting

### Common Issues

**"CORS blocked origin"**
- Check extension origin in CORS allowlist
- Verify extension is loading from expected origin

**"Rate limited"**  
- Reduce request frequency
- Check if multiple extension instances sharing IP

**"Proxy server error"**
- Check server logs
- Verify upstream service availability
- Test individual metadata sources

**"No metadata available"**
- Normal for some stations
- Check stream URL accessibility
- Verify stream provides metadata

### Development Issues

**Local CORS errors:**
- Add your local extension origin to CORS allowlist
- Use localhost:3000 for development

**Dependencies missing:**
- Run `npm install` in proxy directory
- Check Node.js version >= 18

## Extension Integration

The extension uses `metadataProxy.js` to communicate with this service:

```javascript
const metadata = await fetchNowPlaying({
  streamUrl: 'https://stream.example.com/radio',
  stationId: '12345',
  homepage: 'https://station.example.com',
  country: 'US'
});
```

**Routing Logic:**
- HLS streams (`.m3u8`) → Local hls.js processing
- All other streams → Metadata proxy
- Proxy failure → Local fallback (emergency only)

The extension maintains 1:1 compatibility with existing UI display patterns.