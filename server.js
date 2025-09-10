const express = require('express');
const cors = require('cors');
const pino = require('pino');
const { LRUCache } = require('lru-cache');
const { request } = require('undici');
const { fetchMetadata } = require('./strategies/index.js');

const app = express();
const port = process.env.PORT || 3000;
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Timeout configuration
const DEFAULT_TIMEOUT = 6000;
const FAST_TIMEOUT = 2500;

// LRU cache for metadata responses
const cache = new LRUCache({
  max: 1000, // maximum number of items
  ttl: 15 * 1000, // default TTL of 15 seconds
});

// Rate limiting - simple in-memory store
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // max requests per window per IP

function rateLimit(req, res, next) {
  const clientId = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(clientId)) {
    rateLimitMap.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const clientData = rateLimitMap.get(clientId);
  if (now > clientData.resetTime) {
    clientData.count = 1;
    clientData.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      ok: false,
      reason: 'rate-limited',
      message: 'Too many requests',
      fetchedAt: now,
      cacheTtl: 10
    });
  }
  
  clientData.count++;
  next();
}

// Clean up rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [clientId, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) {
      rateLimitMap.delete(clientId);
    }
  }
}, 5 * 60 * 1000); // cleanup every 5 minutes

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests from Chrome extension origins
    const allowedOrigins = [
      /^chrome-extension:\/\/.*$/,
      /^moz-extension:\/\/.*$/,
      'http://localhost:3000', // development
      'http://127.0.0.1:3000'  // development
    ];
    
    // Allow no origin for non-browser requests
    if (!origin) return callback(null, true);
    
    const isAllowed = allowedOrigins.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(origin);
      }
      return pattern === origin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn({ origin }, 'CORS blocked origin');
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: false,
  methods: ['GET', 'HEAD'],
  allowedHeaders: ['Content-Type', 'User-Agent']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit);

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      ip: req.ip
    }, 'Request completed');
  });
  
  next();
});

// Input validation helper
function validateMetadataRequest(query) {
  const { url, stationId, homepage, country } = query;
  
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Missing or invalid stream URL' };
  }
  
  if (url.length > 2000) {
    return { valid: false, error: 'Stream URL too long' };
  }
  
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { valid: false, error: 'Invalid URL scheme (only http/https allowed)' };
    }
  } catch (e) {
    return { valid: false, error: 'Invalid URL format' };
  }
  
  // Validate optional parameters
  if (stationId && (typeof stationId !== 'string' || stationId.length > 100)) {
    return { valid: false, error: 'Invalid stationId' };
  }
  
  if (homepage && (typeof homepage !== 'string' || homepage.length > 500)) {
    return { valid: false, error: 'Invalid homepage URL' };
  }
  
  if (country && (typeof country !== 'string' || country.length > 10)) {
    return { valid: false, error: 'Invalid country code' };
  }
  
  return { valid: true };
}

// Input validation helper for playlist requests
function validatePlaylistRequest(query) {
  const { action, url } = query;
  
  // Validate action parameter
  if (!action || typeof action !== 'string') {
    return { valid: false, error: 'Missing or invalid action parameter' };
  }
  
  if (!['fetch_m3u', 'fetch_playlist'].includes(action)) {
    return { valid: false, error: 'Invalid action (only fetch_m3u and fetch_playlist supported)' };
  }
  
  // Validate URL parameter
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Missing or invalid playlist URL' };
  }
  
  if (url.length > 2000) {
    return { valid: false, error: 'Playlist URL too long' };
  }
  
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { valid: false, error: 'Invalid URL scheme (only http/https allowed)' };
    }
    
    // Additional validation for playlist files
    const isM3U = url.toLowerCase().includes('.m3u');
    const isPLS = url.toLowerCase().includes('.pls');
    
    if (action === 'fetch_m3u' && !isM3U) {
      return { valid: false, error: 'URL does not appear to be an M3U playlist' };
    }
    
    if (action === 'fetch_playlist' && !(isM3U || isPLS)) {
      return { valid: false, error: 'URL does not appear to be a supported playlist format' };
    }
  } catch (e) {
    return { valid: false, error: 'Invalid URL format' };
  }
  
  return { valid: true };
}

// M3U playlist fetching and parsing utility
async function fetchAndParseM3U(url) {
  
  try {
    // Fetch the M3U playlist with timeout
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headersTimeout: DEFAULT_TIMEOUT,
      bodyTimeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'RadioDock-Proxy/1.0'
      }
    });
    
    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode}: Failed to fetch playlist`);
    }
    
    // Read the response body
    const text = await body.text();
    
    if (!text || text.trim().length === 0) {
      throw new Error('Empty playlist file');
    }
    
    // Parse M3U playlist
    const lines = text.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Filter out comments and empty lines
    
    if (lines.length === 0) {
      throw new Error('No stream URLs found in playlist');
    }
    
    // Get the first valid URL
    let streamUrl = lines[0];
    
    // If it's a relative URL, make it absolute
    if (streamUrl && !streamUrl.includes('://')) {
      const baseUrl = new URL(url);
      if (streamUrl.startsWith('/')) {
        streamUrl = `${baseUrl.protocol}//${baseUrl.host}${streamUrl}`;
      } else {
        const basePath = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/') + 1);
        streamUrl = `${baseUrl.protocol}//${baseUrl.host}${basePath}${streamUrl}`;
      }
    }
    
    // Validate the resolved URL
    if (!streamUrl || !streamUrl.includes('://')) {
      throw new Error('Invalid stream URL in playlist');
    }
    
    // Check if the resolved URL is another M3U file (nested playlist)
    if (streamUrl.toLowerCase().includes('.m3u')) {
      throw new Error(`Nested M3U playlist detected: ${streamUrl} - not supported`);
    }
    
    return streamUrl;
    
  } catch (error) {
    logger.error({ url, error: error.message }, 'M3U playlist fetch failed');
    throw error;
  }
}

// PLS playlist fetching and parsing utility
async function fetchAndParsePLS(url) {
  try {
    // Fetch the PLS playlist with timeout
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headersTimeout: DEFAULT_TIMEOUT,
      bodyTimeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'RadioDock-Proxy/1.0'
      }
    });
    
    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode}: Failed to fetch playlist`);
    }
    
    // Read the response body
    const text = await body.text();
    
    if (!text || text.trim().length === 0) {
      throw new Error('Empty playlist file');
    }
    
    // Parse PLS playlist
    const lines = text.split('\n').map(line => line.trim());
    const urls = [];
    
    // Look for File1=, File2=, etc. entries
    for (const line of lines) {
      if (line.startsWith('File') && line.includes('=')) {
        const urlPart = line.substring(line.indexOf('=') + 1);
        if (urlPart && urlPart.includes('://')) {
          urls.push(urlPart);
        }
      }
    }
    
    if (urls.length === 0) {
      throw new Error('No stream URLs found in PLS playlist');
    }
    
    // Return the first URL (usually the primary stream)
    const streamUrl = urls[0];
    
    // Check if the resolved URL is another playlist file (nested playlist)
    if (streamUrl.toLowerCase().includes('.m3u') || streamUrl.toLowerCase().includes('.pls')) {
      throw new Error(`Nested playlist detected: ${streamUrl} - not supported`);
    }
    
    return streamUrl;
    
  } catch (error) {
    logger.error({ url, error: error.message }, 'PLS playlist fetch failed');
    throw error;
  }
}

// Generic playlist fetching and parsing utility
async function fetchAndParsePlaylist(url) {
  const isM3U = url.toLowerCase().includes('.m3u') && !url.toLowerCase().includes('.m3u8');
  const isPLS = url.toLowerCase().includes('.pls');
  
  if (isM3U) {
    return await fetchAndParseM3U(url);
  } else if (isPLS) {
    return await fetchAndParsePLS(url);
  } else {
    throw new Error('Unsupported playlist format');
  }
}

// Root endpoint - redirect to health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'RadioDock Metadata Proxy',
    status: 'ok',
    endpoints: {
      health: '/health',
      metadata: '/v1/metadata',
      playlist: '/v1/playlist'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});


// Main metadata endpoint
app.get('/v1/metadata', async (req, res) => {
  const fetchedAt = Date.now();
  const { url: streamUrl, stationId, homepage, country } = req.query;
  
  // Input validation
  const validation = validateMetadataRequest(req.query);
  if (!validation.valid) {
    return res.json({
      ok: false,
      stationId: stationId || null,
      streamUrl: streamUrl || '',
      reason: 'invalid-url',
      message: validation.error,
      fetchedAt,
      cacheTtl: 10
    });
  }
  
  // Check if URL looks like HLS
  if (streamUrl.includes('.m3u8')) {
    return res.json({
      ok: false,
      stationId: stationId || null,
      streamUrl,
      reason: 'hls-client',
      message: 'HLS streams should be handled client-side',
      fetchedAt,
      cacheTtl: 10
    });
  }
  
  // Generate cache key
  const cacheKey = `${streamUrl}|${stationId || ''}|${homepage || ''}|${country || ''}`;
  
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.debug({ streamUrl, cacheKey }, 'Cache hit');
    return res.json(cached);
  }
  
  try {
    // Add overall timeout for metadata fetching
    const fetchTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 12000); // 12 second global timeout
    });
    
    // Fetch metadata using strategies with race condition
    const result = await Promise.race([
      fetchMetadata({
        streamUrl,
        stationId,
        homepage,
        country
      }),
      fetchTimeout
    ]);
    
    const response = {
      ok: true,
      stationId: stationId || null,
      streamUrl,
      source: result.source || 'unknown',
      artist: result.artist || null,
      title: result.title || null,
      display: result.display || '',
      raw: result.raw || {},
      fetchedAt,
      cacheTtl: result.cacheTtl || 15
    };
    
    // Cache the response
    cache.set(cacheKey, response, { ttl: response.cacheTtl * 1000 });
    
    logger.debug({ 
      streamUrl, 
      source: response.source, 
      display: response.display 
    }, 'Metadata fetched successfully');
    
    res.json(response);
    
  } catch (error) {
    logger.error({ 
      error: error.message, 
      streamUrl, 
      stack: error.stack 
    }, 'Metadata fetch failed');
    
    const errorResponse = {
      ok: false,
      stationId: stationId || null,
      streamUrl,
      reason: error.code === 'TIMEOUT' ? 'timeout' : 'upstream-error',
      message: error.message || 'Failed to fetch metadata',
      fetchedAt,
      cacheTtl: 10
    };
    
    res.json(errorResponse);
  }
});

// Playlist resolution endpoint (M3U/PLS)
app.get('/v1/playlist', async (req, res) => {
  const fetchedAt = Date.now();
  const { action, url: playlistUrl } = req.query;
  
  // Input validation
  const validation = validatePlaylistRequest(req.query);
  if (!validation.valid) {
    return res.json({
      success: false,
      error: validation.error,
      fetchedAt,
      cacheTtl: 10
    });
  }
  
  // Create cache key for playlist
  const cacheKey = `playlist:${playlistUrl}`;
  
  // Check cache first (short TTL for playlists as they can change)
  if (cache.has(cacheKey)) {
    const cachedResponse = cache.get(cacheKey);
    logger.info({ playlistUrl, cached: true }, 'Playlist cache hit');
    return res.json({
      ...cachedResponse,
      cached: true
    });
  }
  
  try {
    logger.info({ action, playlistUrl }, 'Fetching playlist');
    
    // Fetch and parse the playlist (supports M3U and PLS)
    const streamUrl = await fetchAndParsePlaylist(playlistUrl);
    
    const response = {
      success: true,
      streamUrl,
      fetchedAt,
      cached: false,
      cacheTtl: 60 // Cache for 1 minute (playlists can change)
    };
    
    // Cache the response with short TTL
    cache.set(cacheKey, {
      success: true,
      streamUrl,
      fetchedAt
    }, { ttl: 60 * 1000 }); // 1 minute TTL
    
    logger.info({ 
      playlistUrl,
      streamUrl,
      cached: false
    }, 'Playlist resolved successfully');
    
    res.json(response);
    
  } catch (error) {
    logger.error({ 
      error: error.message, 
      playlistUrl, 
      stack: error.stack 
    }, 'Playlist resolution failed');
    
    const errorResponse = {
      success: false,
      error: error.message || 'Failed to resolve playlist',
      fetchedAt,
      cacheTtl: 30 // Short cache for errors
    };
    
    res.json(errorResponse);
  }
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(500).json({
    ok: false,
    reason: 'server-error',
    message: 'Internal server error',
    fetchedAt: Date.now(),
    cacheTtl: 5
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    reason: 'not-found',
    message: 'Endpoint not found',
    fetchedAt: Date.now(),
    cacheTtl: 60
  });
});

app.listen(port, '0.0.0.0', () => {
  logger.info({ 
    port, 
    env: process.env.NODE_ENV || 'development',
    endpoints: ['/', '/health', '/v1/metadata', '/v1/playlist']
  }, 'RadioDock metadata proxy server started');
});

module.exports = app;