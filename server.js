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
  
  if (!streamUrl) {
    return res.status(400).json({
      error: 'Missing required parameter: url'
    });
  }

  try {
    const metadata = await fetchMetadata(streamUrl);
    res.json({
      success: true,
      url: streamUrl,
      metadata: metadata || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Metadata fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      url: streamUrl,
      timestamp: new Date().toISOString()
    });
  }
});

// Main metadata fetching logic
async function fetchMetadata(streamUrl) {
  const strategies = [
    () => fetchNTSMetadata(streamUrl),
    () => fetchAirtimeProMetadata(streamUrl),
    () => fetchRadioKingMetadata(streamUrl),
    () => fetchIcecastMetadata(streamUrl),
    () => fetchICYMetadata(streamUrl),
    () => fetchGenericMetadata(streamUrl)
  ];

  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result && result.nowPlaying) {
        console.log(`Found metadata via strategy: ${result.source || 'unknown'}`);
        return result;
      }
    } catch (error) {
      // Continue to next strategy
      continue;
    }
  }

  return null;
}

// NTS Live metadata
async function fetchNTSMetadata(streamUrl) {
  if (!streamUrl.includes('nts') && !streamUrl.includes('nts.live')) {
    return null;
  }

  try {
    const response = await fetchWithTimeout('https://www.nts.live/api/v2/live', {
      cache: 'no-store'
    });

    if (!response.ok) return null;
    
    const data = await response.json();
    const liveShow = data.results && data.results[0];
    
    if (liveShow && liveShow.now) {
      const show = liveShow.now;
      return {
        nowPlaying: `${show.broadcast_title || 'NTS Live'} - ${show.name || 'Live Show'}`,
        source: 'nts'
      };
    }
  } catch (error) {
    console.error('NTS metadata failed:', error.message);
  }
  
  return null;
}

// Airtime Pro metadata
async function fetchAirtimeProMetadata(streamUrl) {
  try {
    const urlObj = new URL(streamUrl);
    const host = urlObj.hostname || '';
    
    // Check for Airtime Pro pattern
    const airtimeMatch = host.match(/^(.+)\.out\.airtime\.pro$/);
    if (airtimeMatch) {
      const endpoint = `https://${airtimeMatch[1]}.airtime.pro/api/live-info-v2`;
      
      const response = await fetchWithTimeout(endpoint, {
        cache: 'no-store'
      }, 3000);
      
      if (!response.ok) return null;
      
      const data = await response.json();
      if (data && data.shows && data.shows.current) {
        const current = data.shows.current;
        return {
          nowPlaying: `${current.name || 'Live Show'} - ${current.description || ''}`.trim(),
          source: 'airtimepro'
        };
      }
    }
    
    // Special case for Cashmere Radio
    if (streamUrl.toLowerCase().includes('cashmere') || host.includes('cashmereradio')) {
      const response = await fetchWithTimeout('https://cashmereradio.airtime.pro/api/live-info-v2', {
        cache: 'no-store'
      }, 3000);
      
      if (response.ok) {
        const data = await response.json();
        if (data && data.shows && data.shows.current) {
          const current = data.shows.current;
          return {
            nowPlaying: `${current.name || 'Cashmere Radio'} - ${current.description || ''}`.trim(),
            source: 'airtimepro-cashmere'
          };
        }
      }
    }
  } catch (error) {
    console.error('Airtime Pro metadata failed:', error.message);
  }
  
  return null;
}

// RadioKing metadata
async function fetchRadioKingMetadata(streamUrl) {
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
async function fetchICYMetadata(streamUrl) {
  try {
    const response = await fetchWithTimeout(streamUrl, {
      method: 'GET',
      headers: {
        'Icy-MetaData': '1',
        'Range': 'bytes=0-8192' // Only fetch first 8KB
      }
    }, 8000);
    
    if (!response.ok) return null;
    
    const icyMetaInt = parseInt(response.headers.get('icy-metaint'));
    if (!icyMetaInt || icyMetaInt <= 0) return null;
    
    // Read stream data to extract ICY metadata
    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);
    
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
async function fetchGenericMetadata(streamUrl) {
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