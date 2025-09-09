const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors({
  origin: '*', // Allow all origins for browser extensions
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Utility function to fetch with timeout
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'RadioDock-MetadataProxy/1.0',
        ...options.headers
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'RadioDock Metadata Proxy',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      metadata: '/metadata?url=STREAM_URL',
      health: '/'
    }
  });
});

// Main metadata endpoint
app.get('/metadata', async (req, res) => {
  const { url: streamUrl } = req.query;
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`\n🎵 [${requestId}] METADATA REQUEST START`);
  console.log(`📡 [${requestId}] Stream URL: ${streamUrl}`);
  
  if (!streamUrl) {
    console.log(`❌ [${requestId}] Missing stream URL parameter`);
    return res.status(400).json({
      error: 'Missing required parameter: url'
    });
  }

  try {
    const startTime = Date.now();
    const metadata = await fetchMetadata(streamUrl, requestId);
    const duration = Date.now() - startTime;
    
    if (metadata) {
      console.log(`✅ [${requestId}] SUCCESS: Found metadata via ${metadata.source}`);
      console.log(`🎶 [${requestId}] Now Playing: "${metadata.nowPlaying}"`);
      console.log(`⏱️  [${requestId}] Total fetch time: ${duration}ms`);
    } else {
      console.log(`❌ [${requestId}] NO METADATA FOUND after ${duration}ms`);
    }
    
    res.json({
      success: true,
      url: streamUrl,
      metadata: metadata || null,
      fetchTime: duration,
      timestamp: new Date().toISOString()
    });
    
    console.log(`📤 [${requestId}] METADATA REQUEST END\n`);
  } catch (error) {
    console.error(`💥 [${requestId}] Metadata fetch error:`, error.message);
    console.error(`💥 [${requestId}] Stack trace:`, error.stack);
    res.status(500).json({
      success: false,
      error: error.message,
      url: streamUrl,
      timestamp: new Date().toISOString()
    });
    console.log(`📤 [${requestId}] METADATA REQUEST END (ERROR)\n`);
  }
});

// Main metadata fetching logic
async function fetchMetadata(streamUrl, requestId) {
  const strategies = [
    { name: 'NTS', fn: () => fetchNTSMetadata(streamUrl, requestId) },
    { name: 'Airtime Pro', fn: () => fetchAirtimeProMetadata(streamUrl, requestId) },
    { name: 'RadioKing', fn: () => fetchRadioKingMetadata(streamUrl, requestId) },
    { name: 'Icecast JSON', fn: () => fetchIcecastMetadata(streamUrl, requestId) },
    { name: 'ICY Headers', fn: () => fetchICYMetadata(streamUrl, requestId) },
    { name: 'Generic APIs', fn: () => fetchGenericMetadata(streamUrl, requestId) }
  ];

  console.log(`🔄 [${requestId}] Testing ${strategies.length} metadata strategies...`);

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const strategyStart = Date.now();
    
    console.log(`🧪 [${requestId}] Strategy ${i + 1}/${strategies.length}: ${strategy.name}`);
    
    try {
      const result = await strategy.fn();
      const strategyTime = Date.now() - strategyStart;
      
      if (result && result.nowPlaying && result.nowPlaying.trim().length > 0) {
        console.log(`✅ [${requestId}] ${strategy.name} SUCCESS (${strategyTime}ms): "${result.nowPlaying}"`);
        return result;
      } else {
        console.log(`⚪ [${requestId}] ${strategy.name} returned empty result (${strategyTime}ms)`);
      }
    } catch (error) {
      const strategyTime = Date.now() - strategyStart;
      console.log(`❌ [${requestId}] ${strategy.name} failed (${strategyTime}ms): ${error.message}`);
      continue;
    }
  }

  console.log(`❌ [${requestId}] All ${strategies.length} strategies exhausted - no metadata found`);
  return null;
}

// NTS Live metadata
async function fetchNTSMetadata(streamUrl, requestId) {
  if (!streamUrl.includes('nts') && !streamUrl.includes('nts.live')) {
    console.log(`⚪ [${requestId}] NTS: Not an NTS URL, skipping`);
    return null;
  }

  const apiUrl = 'https://www.nts.live/api/v2/live';
  console.log(`🔍 [${requestId}] NTS: Fetching from ${apiUrl}`);

  try {
    const response = await fetchWithTimeout(apiUrl, {
      cache: 'no-store'
    });

    console.log(`🌍 [${requestId}] NTS: API response status ${response.status}`);
    if (!response.ok) {
      console.log(`❌ [${requestId}] NTS: API returned ${response.status}: ${response.statusText}`);
      return null;
    }
    
    const data = await response.json();
    console.log(`📊 [${requestId}] NTS: Response data:`, JSON.stringify(data, null, 2));
    
    const liveShow = data.results && data.results[0];
    
    if (liveShow && liveShow.now) {
      const show = liveShow.now;
      const nowPlaying = `${show.broadcast_title || 'NTS Live'} - ${show.name || 'Live Show'}`;
      console.log(`✅ [${requestId}] NTS: Found show data - "${nowPlaying}"`);
      return {
        nowPlaying: nowPlaying,
        source: 'nts'
      };
    } else {
      console.log(`⚪ [${requestId}] NTS: No live show data found in response`);
    }
  } catch (error) {
    console.error(`❌ [${requestId}] NTS metadata failed:`, error.message);
  }
  
  return null;
}

// Airtime Pro metadata
async function fetchAirtimeProMetadata(streamUrl, requestId) {
  try {
    const urlObj = new URL(streamUrl);
    const host = urlObj.hostname || '';
    console.log(`🔍 [${requestId}] Airtime Pro: Analyzing host "${host}"`);
    
    // Check for Airtime Pro pattern
    const airtimeMatch = host.match(/^(.+)\.out\.airtime\.pro$/);
    if (airtimeMatch) {
      const endpoint = `https://${airtimeMatch[1]}.airtime.pro/api/live-info-v2`;
      console.log(`📡 [${requestId}] Airtime Pro: Detected pattern, trying ${endpoint}`);
      
      const response = await fetchWithTimeout(endpoint, {
        cache: 'no-store'
      }, 3000);
      
      console.log(`🌍 [${requestId}] Airtime Pro: Response status ${response.status}`);
      if (!response.ok) {
        console.log(`❌ [${requestId}] Airtime Pro: API returned ${response.status}: ${response.statusText}`);
        return null;
      }
      
      const data = await response.json();
      console.log(`📊 [${requestId}] Airtime Pro: Response data:`, JSON.stringify(data, null, 2));
      
      if (data && data.shows && data.shows.current) {
        const current = data.shows.current;
        const nowPlaying = `${current.name || 'Live Show'} - ${current.description || ''}`.trim();
        console.log(`✅ [${requestId}] Airtime Pro: Found show "${nowPlaying}"`);
        return {
          nowPlaying: nowPlaying,
          source: 'airtimepro'
        };
      } else {
        console.log(`⚪ [${requestId}] Airtime Pro: No current show data found`);
      }
    }
    
    // Special case for Cashmere Radio
    if (streamUrl.toLowerCase().includes('cashmere') || host.includes('cashmereradio')) {
      const endpoint = 'https://cashmereradio.airtime.pro/api/live-info-v2';
      console.log(`📡 [${requestId}] Airtime Pro: Cashmere detected, trying ${endpoint}`);
      
      const response = await fetchWithTimeout(endpoint, {
        cache: 'no-store'
      }, 3000);
      
      console.log(`🌍 [${requestId}] Airtime Pro Cashmere: Response status ${response.status}`);
      if (response.ok) {
        const data = await response.json();
        console.log(`📊 [${requestId}] Airtime Pro Cashmere: Response data:`, JSON.stringify(data, null, 2));
        
        if (data && data.shows && data.shows.current) {
          const current = data.shows.current;
          const nowPlaying = `${current.name || 'Cashmere Radio'} - ${current.description || ''}`.trim();
          console.log(`✅ [${requestId}] Airtime Pro Cashmere: Found show "${nowPlaying}"`);
          return {
            nowPlaying: nowPlaying,
            source: 'airtimepro-cashmere'
          };
        } else {
          console.log(`⚪ [${requestId}] Airtime Pro Cashmere: No current show data found`);
        }
      }
    } else {
      console.log(`⚪ [${requestId}] Airtime Pro: No recognizable patterns found`);
    }
  } catch (error) {
    console.error(`❌ [${requestId}] Airtime Pro metadata failed:`, error.message);
  }
  
  return null;
}

// RadioKing metadata
async function fetchRadioKingMetadata(streamUrl, requestId) {
  console.log(`🔍 [${requestId}] RadioKing: Analyzing URL for RadioKing patterns`);
  try {
    const urlObj = new URL(streamUrl);
    const pathMatch = urlObj.pathname.match(/\/radio\/(\d+)/);
    
    if (!pathMatch) return null;
    
    const radioId = pathMatch[1];
    const endpoints = [
      `https://www.radioking.com/api/radio/${radioId}/track/current`,
      `https://api.radioking.com/widget/radio/${radioId}`,
      `https://www.radioking.com/api/radio/${radioId}`,
      `${urlObj.protocol}//${urlObj.host}/api/radio/${radioId}/track/current`
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await fetchWithTimeout(endpoint, {
          cache: 'no-store'
        }, 3000);
        
        if (response.ok) {
          const data = await response.json();
          
          if (data.title || data.artist || data.track) {
            const title = data.title || data.track || '';
            const artist = data.artist || '';
            return {
              nowPlaying: artist && title ? `${artist} - ${title}` : (title || artist || 'RadioKing Live'),
              source: 'radioking'
            };
          }
        }
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.error('RadioKing metadata failed:', error.message);
  }
  
  return null;
}

// Icecast JSON status metadata
async function fetchIcecastMetadata(streamUrl) {
  try {
    const urlObj = new URL(streamUrl);
    const mount = urlObj.pathname;
    
    const statusEndpoints = [
      `${urlObj.protocol}//${urlObj.host}/status-json.xsl`,
      `${urlObj.protocol}//${urlObj.host}/status.json`,
      `${urlObj.protocol}//${urlObj.host}/stats.json`
    ];
    
    // Special case for Callshop Radio
    if (streamUrl.includes('callshopradio.com')) {
      statusEndpoints.unshift('https://icecast.callshopradio.com/status-json.xsl');
    }
    
    for (const statusUrl of statusEndpoints) {
      try {
        const response = await fetchWithTimeout(statusUrl, {
          cache: 'no-store'
        }, 3500);
        
        if (!response.ok) continue;
        
        const data = await response.json();
        if (data && data.icestats && data.icestats.source) {
          const sources = Array.isArray(data.icestats.source) 
            ? data.icestats.source 
            : [data.icestats.source];
          
          // Find matching source by mount point
          const source = sources.find(s => 
            s.listenurl?.includes(mount) || 
            s.mount?.includes(mount) || 
            s.path?.includes(mount)
          ) || sources[0];
          
          if (source && (source.title || source.artist)) {
            const title = source.title || '';
            const artist = source.artist || '';
            return {
              nowPlaying: artist && title ? `${artist} - ${title}` : (title || artist || 'Icecast Stream'),
              source: 'icecast'
            };
          }
        }
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.error('Icecast metadata failed:', error.message);
  }
  
  return null;
}

// ICY metadata extraction
async function fetchICYMetadata(streamUrl, requestId) {
  console.log(`🔍 [${requestId}] ICY: Attempting direct stream header extraction from ${streamUrl}`);
  try {
    const response = await fetchWithTimeout(streamUrl, {
      method: 'GET',
      headers: {
        'Icy-MetaData': '1',
        'Range': 'bytes=0-8192' // Only fetch first 8KB
      }
    }, 8000);
    
    console.log(`🌍 [${requestId}] ICY: Stream response status ${response.status}`);
    if (!response.ok) {
      console.log(`❌ [${requestId}] ICY: Stream returned ${response.status}: ${response.statusText}`);
      return null;
    }
    
    // Log all response headers
    console.log(`📊 [${requestId}] ICY: Response headers:`);
    for (const [key, value] of response.headers.entries()) {
      console.log(`   ${key}: ${value}`);
    }
    
    const icyMetaInt = parseInt(response.headers.get('icy-metaint'));
    console.log(`📊 [${requestId}] ICY: icy-metaint header value: ${icyMetaInt}`);
    
    if (!icyMetaInt || icyMetaInt <= 0) {
      console.log(`❌ [${requestId}] ICY: No valid icy-metaint found, stream doesn't support ICY metadata`);
      return null;
    }
    
    // Read stream data to extract ICY metadata
    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);
    console.log(`📊 [${requestId}] ICY: Downloaded ${data.length} bytes of stream data`);
    
    if (data.length > icyMetaInt) {
      const metaLength = data[icyMetaInt] * 16;
      if (metaLength > 0 && data.length >= icyMetaInt + 1 + metaLength) {
        const metaData = new TextDecoder('latin1').decode(
          data.slice(icyMetaInt + 1, icyMetaInt + 1 + metaLength)
        );
        
        const titleMatch = metaData.match(/StreamTitle='([^']*?)'/);
        if (titleMatch && titleMatch[1]) {
          return {
            nowPlaying: titleMatch[1].trim(),
            source: 'icy'
          };
        }
      }
    }
  } catch (error) {
    console.error('ICY metadata failed:', error.message);
  }
  
  return null;
}

// Generic metadata endpoints
async function fetchGenericMetadata(streamUrl, requestId) {
  console.log(`🔍 [${requestId}] Generic: Testing common metadata endpoints`);
  try {
    const urlObj = new URL(streamUrl);
    
    const metadataEndpoints = [
      `${urlObj.protocol}//${urlObj.host}/api/nowplaying`,
      `${urlObj.protocol}//${urlObj.host}/nowplaying`,
      `${urlObj.protocol}//${urlObj.host}/current`,
      `${urlObj.protocol}//${urlObj.host}/metadata`,
      `${urlObj.protocol}//${urlObj.host}/info`,
      `${urlObj.protocol}//${urlObj.host}/playing.json`,
      `${urlObj.protocol}//${urlObj.host}/current.json`,
      `${urlObj.protocol}//${urlObj.host}/api/current`,
      `${urlObj.protocol}//${urlObj.host}/stats`,
      `${urlObj.protocol}//${urlObj.host}/7.html`
    ];
    
    for (const endpoint of metadataEndpoints) {
      try {
        const response = await fetchWithTimeout(endpoint, {
          cache: 'no-store'
        }, 3000);
        
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          let data;
          
          if (contentType.includes('application/json')) {
            data = await response.json();
          } else {
            const text = await response.text();
            try {
              data = JSON.parse(text);
            } catch {
              // Try to extract from HTML/text
              const titleMatch = text.match(/<title>([^<]+)<\/title>/i) ||
                               text.match(/title["\s]*[:=]["\s]*([^"\n\r]+)/i) ||
                               text.match(/now.?playing["\s]*[:=]["\s]*([^"\n\r]+)/i);
              
              if (titleMatch && titleMatch[1]) {
                return {
                  nowPlaying: titleMatch[1].trim(),
                  source: 'generic-html'
                };
              }
              continue;
            }
          }
          
          // Extract metadata from various JSON formats
          const nowPlaying = data.title || data.track || data.song || data.nowplaying || 
                           data.current_track || data.live?.current_track || 
                           (data.artist && data.title ? `${data.artist} - ${data.title}` : null);
          
          if (nowPlaying) {
            return {
              nowPlaying: nowPlaying.toString().trim(),
              source: 'generic'
            };
          }
        }
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.error('Generic metadata failed:', error.message);
  }
  
  return null;
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`RadioDock Metadata Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`Metadata API: http://localhost:${PORT}/metadata?url=STREAM_URL`);
});