# RadioDock Metadata Proxy

A Node.js proxy service that fetches metadata from radio streams for the RadioDock browser extension. This service solves CORS issues and provides a unified API for accessing radio station metadata.

## Features

- ✅ **Universal Metadata Support**: Icecast, ICY headers, RadioKing, NTS Live, Airtime Pro
- ✅ **CORS Enabled**: Works with browser extensions
- ✅ **Error Handling**: Graceful fallbacks and proper error responses
- ✅ **Multiple Strategies**: Tries different methods to find metadata
- ✅ **Render.com Ready**: Configured for easy deployment

## API Endpoints

### GET `/`
Health check endpoint that returns service information.

### GET `/metadata?url=STREAM_URL`
Fetches metadata for a radio stream.

**Parameters:**
- `url` (required): The radio stream URL

**Response:**
```json
{
  "success": true,
  "url": "https://example.com/stream",
  "metadata": {
    "nowPlaying": "Artist - Song Title",
    "source": "icecast"
  },
  "timestamp": "2023-12-07T10:30:00.000Z"
}
```

### GET `/inspect?url=STREAM_URL`
Inspects likely metadata endpoints for a given stream URL and returns a quick summary of which candidates respond and how. Useful to understand differing data structures across hosts (Airtime Pro, Icecast, NTS, generic JSON, etc.).

Example response snippet:
```json
{
  "success": true,
  "url": "https://example.com/stream.mp3",
  "inspected": [
    {
      "type": "icecast",
      "url": "https://example.com/status-json.xsl",
      "status": 200,
      "contentType": "application/json",
      "jsonKeys": ["icestats"],
      "snippet": "{\n  \"icestats\": { ... }"
    },
    {
      "type": "generic",
      "url": "https://example.com/nowplaying",
      "status": 404
    }
  ]
}
```

## Supported Metadata Sources

1. **NTS Live**: Official NTS Live API
2. **Airtime Pro**: Airtime hosted radio stations
3. **RadioKing**: RadioKing hosted stations
4. **Icecast**: JSON status endpoints (`/status-json.xsl`, `/stats.json`)
5. **ICY Headers**: Direct stream metadata parsing
6. **Generic APIs**: Common metadata endpoints (`/nowplaying`, `/current`, etc.)

Stations known to work with built-in strategies:
- NTS (API): `https://www.nts.live/api/v2/live` (handles `stream` and `stream2`)
- Airtime Pro: Kiosk, Cashmere, dublab.de, Radio 80000 via `...airtime.pro/api/live-info-v2`
- Icecast JSON: Callshop Radio via `https://icecast.callshopradio.com/status-json.xsl`
- ICY headers: Streams like WDR 1Live, IHeart/Revma when supported

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. **Test the API:**
   ```bash
   curl "http://localhost:3000/metadata?url=https://example.com/stream"
   ```

## Deployment to Render.com

### Method 1: Using GitHub (Recommended)

1. **Create a Git repository:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. **Push to GitHub:**
   - Create a new repository on GitHub
   - Push your code:
   ```bash
   git remote add origin https://github.com/yourusername/radio-metadata-proxy.git
   git branch -M main
   git push -u origin main
   ```

3. **Deploy on Render.com:**
   - Go to [render.com](https://render.com) and sign up/login
   - Click "New" → "Web Service"
   - Connect your GitHub repository
   - Render will auto-detect the `render.yaml` configuration
   - Click "Create Web Service"

### Method 2: Using Render Dashboard

1. **Go to [render.com](https://render.com)**
2. **Create a new Web Service**
3. **Configure:**
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (or paid for better performance)

4. **Deploy and get your URL** (e.g., `https://your-service.onrender.com`)

## Environment Variables

- `PORT`: Server port (automatically set by Render.com)
- `NODE_ENV`: Set to "production" for production deployment

## Extension Integration

Once deployed, update your RadioDock extension to use your proxy URL:

```javascript
// Replace direct metadata fetching with proxy calls
const proxyUrl = 'https://your-service.onrender.com';
const response = await fetch(`${proxyUrl}/metadata?url=${encodeURIComponent(streamUrl)}`);
const data = await response.json();
```

## Security & Privacy

- All metadata requests are server-side to avoid CORS issues
- No user data is stored or logged
- Stream URLs are only used to fetch metadata, not stored
- User-Agent identifies the service for server logs

## Performance

- **Free Tier**: May have cold starts (15-30 seconds delay after inactivity)
- **Paid Tier**: Always warm, faster response times
- **Caching**: Consider implementing Redis caching for frequently requested streams

## Troubleshooting

### Service Cold Start
If using the free tier, the first request after inactivity may take 15-30 seconds. Subsequent requests will be fast.

### CORS Issues
This service enables CORS for all origins. If you need to restrict access, modify the CORS configuration in `server.js`.

### Timeout Issues
The service has built-in timeouts (3-8 seconds depending on the source). If a metadata source is slow, it will be skipped.

## License

MIT License - see LICENSE file for details.
