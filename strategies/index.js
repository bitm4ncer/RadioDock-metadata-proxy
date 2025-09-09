/**
 * RadioDock Metadata Strategies - Server Implementation
 * 
 * This file ports all metadata fetching strategies from the extension's metadata-strategies.js
 * and background.js to run server-side on the proxy. This maintains 1:1 behavior compatibility
 * while allowing host_permissions to be restricted to only the proxy and Radio Browser API.
 * 
 * Strategy Types Implemented:
 * 1. NTS Radio API - Live channel metadata from nts.live API
 * 2. Airtime Pro - Generic Airtime Pro stations using live-info-v2 API
 * 3. Cashmere Radio - Specific Airtime Pro instance with custom handling
 * 4. Icecast Status - JSON status endpoints (status-json.xsl, status.json, etc.)
 * 5. ICY Metadata - Stream metadata blocks with Icy-MetaData headers
 * 6. Generic APIs - Common station API patterns and endpoints
 * 7. Radio King - radioking.com specific API endpoints
 * 8. Callshop Radio - Custom JSON status endpoint
 * 9. Radio Browser - Fallback using radio-browser.info station data
 * 10. Station Info - Last resort using station name/info
 * 
 * HLS streams (.m3u8) are explicitly excluded and return {ok:false, reason:"hls-client"}
 * so the extension continues to handle HLS ID3 metadata locally with hls.js.
 */

const { request } = require('undici');
const icy = require('icy');

// Timeout configuration
const DEFAULT_TIMEOUT = 8000;
const FAST_TIMEOUT = 3500;

// Shared normalization for now playing strings
function cleanNowPlaying(text) {
  try {
    if (!text) return '';
    let s = String(text).trim();
    
    // Decode HTML entities
    s = s.replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&#039;/g, "'")
         .replace(/&#x27;/g, "'")
         .replace(/&#0*39;/g, "'");
    
    // Remove a leading dash variant like "- ", "– ", "— " (with optional leading spaces)
    s = s.replace(/^\s*[-–—]\s+/, '');
    return s.trim();
  } catch (e) {
    return typeof text === 'string' ? text.trim() : '';
  }
}

// HTTP request utility with timeout
async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await request(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'RadioDock/1.0',
        'Cache-Control': 'no-store',
        ...options.headers
      }
    });
    
    clearTimeout(timeoutId);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      statusCode: response.statusCode,
      headers: response.headers,
      json: async () => JSON.parse(await response.body.text()),
      text: async () => response.body.text(),
      body: response.body
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Common metadata validation and filtering
function isValidMetadata(metadata) {
  if (!metadata || !metadata.display || typeof metadata.display !== 'string') {
    return false;
  }
  
  const text = metadata.display.toLowerCase().trim();
  if (text.length < 3) return false;
  
  // Filter out common generic/unhelpful metadata
  const unwantedPatterns = [
    'unknown', 'untitled', 'live', 'on-air', 'stream', 'radio',
    'broadcasting', 'music', 'live stream', 'internet radio',
    'online radio', 'web radio', 'digital radio', 'airtime!'
  ];
  
  const isGeneric = unwantedPatterns.some(pattern => 
    text === pattern || (text.length < 20 && text.includes(pattern))
  );
  
  return !isGeneric;
}

// Parse artist and title from various formats
function parseArtistTitle(text, artist = '', title = '') {
  if (!text && !artist && !title) return null;
  
  let finalArtist = artist;
  let finalTitle = title;
  
  // If we have text but no separate artist/title, try to parse from text
  if (text && !artist && !title && text.includes(' - ')) {
    const parts = text.split(' - ');
    finalArtist = parts[0].trim();
    finalTitle = parts.slice(1).join(' - ').trim();
  } else if (text && (!artist || !title)) {
    // Use text as fallback
    finalTitle = text;
  }
  
  // Build final now playing string
  let nowPlaying = '';
  if (finalArtist && finalTitle && finalArtist !== finalTitle) {
    nowPlaying = `${finalArtist} - ${finalTitle}`;
  } else if (finalTitle) {
    nowPlaying = finalTitle;
  } else if (finalArtist) {
    nowPlaying = finalArtist;
  } else if (text) {
    nowPlaying = text;
  }
  
  return nowPlaying ? cleanNowPlaying(nowPlaying) : null;
}

// Common JSON parsing for various station API formats
function parseStationMetadata(data) {
  if (!data || typeof data !== 'object') return null;
  
  let artist = '';
  let title = '';
  let nowPlaying = '';
  
  // Try different common API formats
  if (data.nowplaying || data.now_playing) {
    const np = data.nowplaying || data.now_playing;
    if (typeof np === 'string') {
      nowPlaying = np;
    } else if (np && typeof np === 'object') {
      artist = np.artist || np.performer || '';
      title = np.song || np.track || np.title || '';
    }
  } else if (data.current) {
    const current = data.current;
    if (typeof current === 'string') {
      nowPlaying = current;
    } else if (current && typeof current === 'object') {
      title = current.title || current.track || '';
    }
  } else if (data.song || data.track || data.title) {
    artist = data.artist || '';
    title = data.song || data.track || data.title || '';
  }
  
  return parseArtistTitle(nowPlaying, artist, title);
}

// Utility to wait for first resolved promise
function firstNonNullResult(promises) {
  return new Promise((resolve) => {
    let remaining = promises.length;
    let resolved = false;
    if (remaining === 0) return resolve(null);
    
    promises.forEach(promise => {
      promise.then(result => {
        if (!resolved && result && result.display) {
          resolved = true;
          resolve(result);
        }
      }).catch(() => {}).finally(() => {
        remaining -= 1;
        if (!resolved && remaining === 0) {
          resolve(null);
        }
      });
    });
  });
}

// NTS Radio API integration
async function fetchNTSMetadata(streamUrl, stationId) {
  try {
    // Only use NTS API for main live channels (stream-relay)
    if (!streamUrl.includes('stream-relay-geo.ntslive.net')) {
      return null;
    }
    
    const response = await fetchWithTimeout('https://www.nts.live/api/v2/live', {}, 5000);
    if (!response.ok) throw new Error(`NTS API error: ${response.status}`);
    
    const data = await response.json();
    const channels = data.results || [];
    
    // Detect channel from stream URL
    let targetChannel = '1'; // default for /stream
    if (streamUrl.includes('/stream2')) {
      targetChannel = '2';
    }
    
    // Find the matching channel
    let channel = channels.find(r => r.channel_name === targetChannel) || channels[0];
    
    if (channel && channel.now) {
      const now = channel.now;
      
      // Use broadcast_title as the main content, it contains the track info
      let nowPlaying = now.broadcast_title || now.title || '';
      
      // If we have artist info from embeds, use that instead
      if (now.embeds?.details?.name) {
        nowPlaying = now.embeds.details.name;
      }
      
      nowPlaying = cleanNowPlaying(nowPlaying);
      
      if (nowPlaying) {
        return {
          source: 'nts',
          display: nowPlaying,
          artist: null,
          title: null,
          raw: { channel: channel.channel_name === '2' ? 'NTS 2' : 'NTS 1', ...now },
          confidence: 0.9,
          cacheTtl: 30
        };
      }
    }
  } catch (error) {
    console.error('NTS API fetch failed:', error);
  }
  return null;
}

// Airtime Pro integration
function deriveAirtimeProEndpointFromStream(streamUrl) {
  try {
    if (!streamUrl) return null;
    const u = new URL(streamUrl);
    const host = u.hostname || '';
    // Expect pattern like: <station>.out.airtime.pro
    const m = host.match(/^([^.]+)\.out\.airtime\.pro$/i);
    if (!m) return null;
    const stationKey = m[1];
    return `https://${stationKey}.airtime.pro/api/live-info-v2`;
  } catch (e) {
    return null;
  }
}

function parseAirtimeProNowPlaying(data) {
  // Prefer track-level info from Airtime Pro structure
  const currentTrack = data?.tracks?.current;
  const meta = currentTrack?.metadata;
  const rawArtist = (meta?.artist_name || meta?.artist || '').trim();
  let rawTitle = (meta?.track_title || '').trim();
  if (!rawTitle && typeof currentTrack?.name === 'string') {
    rawTitle = currentTrack.name.replace(/^\s*-\s*/, '').trim();
  }

  // Show name from schedule
  const showNameRaw = (data?.shows?.current?.name || '').trim();
  const showName = showNameRaw && !/airtime/i.test(showNameRaw) && !/archive/i.test(showNameRaw)
    ? showNameRaw
    : '';

  // Build track component first (artist - title if both; else the one available)
  let trackComponent = null;
  if (rawArtist && rawTitle) trackComponent = `${rawArtist} - ${rawTitle}`;
  else if (rawTitle) trackComponent = rawTitle;
  else if (rawArtist) trackComponent = rawArtist;

  let nowPlaying = null;
  if (showName && trackComponent) {
    // Avoid duplicating if track already starts with show name
    const lcShow = showName.toLowerCase();
    const lcTrack = trackComponent.toLowerCase();
    if (!lcTrack.startsWith(lcShow + ' - ') && lcShow !== lcTrack) {
      nowPlaying = `${showName} - ${trackComponent}`;
    } else {
      nowPlaying = trackComponent;
    }
  } else if (trackComponent) {
    nowPlaying = trackComponent;
  } else if (showName) {
    nowPlaying = showName;
  }

  // Last-resort generic keys
  if (!nowPlaying) {
    const np = data?.now || data?.now_playing || data?.nowPlaying;
    if (typeof np === 'string') nowPlaying = np.trim();
    else if (np && (np.title || np.name)) nowPlaying = (np.title || np.name).trim();
  }

  return cleanNowPlaying(nowPlaying);
}

async function fetchAirtimeProMetadata(streamUrl, providedEndpoint) {
  try {
    const endpoint = providedEndpoint || deriveAirtimeProEndpointFromStream(streamUrl);
    if (!endpoint) return null;

    const response = await fetchWithTimeout(endpoint, {}, 5000);
    if (!response.ok) return null;

    const data = await response.json();
    const nowPlaying = parseAirtimeProNowPlaying(data);
    
    if (nowPlaying && nowPlaying.trim().length > 0) {
      return {
        source: 'airtimepro',
        display: nowPlaying.trim(),
        artist: null,
        title: null,
        raw: data,
        confidence: 0.8,
        cacheTtl: 20
      };
    }
    return null;
  } catch (e) {
    console.error('Airtime Pro metadata fetch failed:', e);
    return null;
  }
}

// Cashmere Radio (specific Airtime Pro instance)
async function fetchCashmereMetadata() {
  try {
    const endpoint = 'https://cashmereradio.airtime.pro/api/live-info-v2';
    const response = await fetchWithTimeout(endpoint, {}, 5000);
    if (!response.ok) throw new Error(`Cashmere API error: ${response.status}`);

    const data = await response.json();
    const nowPlaying = parseAirtimeProNowPlaying(data);

    if (nowPlaying && nowPlaying.trim().length > 0) {
      return {
        source: 'cashmere',
        display: nowPlaying.trim(),
        artist: null,
        title: null,
        raw: data,
        confidence: 0.9,
        cacheTtl: 20
      };
    }

    return null;
  } catch (error) {
    console.error('Cashmere metadata fetch failed:', error);
    return null;
  }
}

// Icecast status JSON endpoints
async function fetchIcecastMetadata(endpoints, mount) {
  try {
    const attempt = async (statusUrl) => {
      try {
        const response = await fetchWithTimeout(statusUrl, {}, FAST_TIMEOUT);
        if (!response.ok) return null;

        const data = await response.json();
        let sources = [];

        if (data.icestats?.source) {
          sources = Array.isArray(data.icestats.source) ? data.icestats.source : [data.icestats.source];
        }

        const source = sources.find(s => 
          (s.listenurl && mount && s.listenurl.includes(mount)) ||
          (s.mount && mount && s.mount === mount) ||
          (s.server_name && mount && s.server_name.includes(mount))
        ) || sources[0];

        if (source && (source.title || source.artist || source.song || source.track || source.track_title || source.artist_name)) {
          const title = source.title || source.song || source.track || source.track_title || '';
          const artist = source.artist || source.performer || source.artist_name || '';

          let parsedArtist = artist;
          let parsedTitle = title;
          if (!artist && title.includes(' - ')) {
            const parts = title.split(' - ');
            parsedArtist = parts[0].trim();
            parsedTitle = parts.slice(1).join(' - ').trim();
          }

          let nowPlaying = '';
          if (parsedArtist && parsedTitle && parsedArtist !== parsedTitle) nowPlaying = `${parsedArtist} - ${parsedTitle}`;
          else if (parsedTitle) nowPlaying = parsedTitle;
          else if (parsedArtist) nowPlaying = parsedArtist;

          if (nowPlaying && nowPlaying.length > 3) {
            const filtered = nowPlaying.toLowerCase();
            const unwantedPatterns = ['unknown', 'untitled', 'live', 'on-air', 'stream', 'radio'];
            const isGeneric = unwantedPatterns.some(pattern =>
              filtered === pattern || (filtered.length < 15 && filtered.includes(pattern))
            );
            if (!isGeneric) {
              return {
                source: 'icecast-status',
                display: nowPlaying,
                artist: parsedArtist || null,
                title: parsedTitle || null,
                raw: { source, endpoint: statusUrl },
                confidence: 0.8,
                cacheTtl: 15
              };
            }
          }
        }
        return null;
      } catch (error) {
        if (error.name === 'AbortError') return null;
        return null;
      }
    };

    const promises = endpoints.map(e => attempt(e));
    return await firstNonNullResult(promises) || null;
  } catch (e) {
    return null;
  }
}

// ICY metadata parsing with stream data extraction
async function fetchICYMetadata(streamUrl) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, DEFAULT_TIMEOUT);

    try {
      const stream = icy.get(streamUrl, (res) => {
        clearTimeout(timeout);
        
        // Set up metadata listener
        res.on('metadata', (metadata) => {
          try {
            const parsed = icy.parse(metadata);
            let nowPlaying = null;
            
            if (parsed.StreamTitle) {
              nowPlaying = parsed.StreamTitle.trim();
            } else if (parsed.StreamArtist && parsed.StreamTitle) {
              nowPlaying = `${parsed.StreamArtist.trim()} - ${parsed.StreamTitle.trim()}`;
            } else if (parsed.StreamArtist) {
              nowPlaying = parsed.StreamArtist.trim();
            }
            
            if (nowPlaying && nowPlaying.length > 3) {
              const filtered = nowPlaying.toLowerCase();
              const unwantedPatterns = [
                'unknown', 'airtime!', 'live', 'on-air', 'radio', 'stream',
                'broadcasting', 'music', 'live stream', 'internet radio',
                'online radio', 'web radio', 'digital radio'
              ];
              
              const isGeneric = unwantedPatterns.some(pattern => 
                filtered === pattern || 
                (filtered.length < 20 && filtered.includes(pattern))
              );
              
              if (!isGeneric) {
                stream.destroy();
                resolve({
                  source: 'icy',
                  display: nowPlaying,
                  artist: parsed.StreamArtist || null,
                  title: parsed.StreamTitle || null,
                  raw: parsed,
                  confidence: 0.9,
                  cacheTtl: 15
                });
                return;
              }
            }
            
            // Fallback to headers
            const icyName = res.headers['icy-name'];
            const icyDescription = res.headers['icy-description'];
            
            if (icyName && icyName !== icyDescription) {
              stream.destroy();
              resolve({
                source: 'icy-headers',
                display: icyName,
                artist: null,
                title: null,
                raw: { headers: res.headers },
                confidence: 0.6,
                cacheTtl: 30
              });
              return;
            }
            
            stream.destroy();
            resolve(null);
          } catch (error) {
            stream.destroy();
            resolve(null);
          }
        });
        
        res.on('error', () => {
          stream.destroy();
          resolve(null);
        });
        
        // Read some data to trigger metadata
        let dataReceived = false;
        res.on('data', () => {
          if (!dataReceived) {
            dataReceived = true;
            // Give it a moment to receive metadata
            setTimeout(() => {
              if (!resolved) {
                stream.destroy();
                resolve(null);
              }
            }, 2000);
          }
        });
      });
      
      stream.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
      
    } catch (error) {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

// Generic metadata fetcher for various station APIs
async function fetchGenericMetadata(streamUrl, station) {
  try {
    const urlObj = new URL(streamUrl);
    
    // Special handling for Callshop Radio
    if (streamUrl.includes('callshopradio.com')) {
      try {
        const response = await fetchWithTimeout('https://icecast.callshopradio.com/status-json.xsl');
        
        if (response.ok) {
          const data = await response.json();
          let sources = [];
          if (data.icestats?.source) {
            sources = Array.isArray(data.icestats.source) ? data.icestats.source : [data.icestats.source];
          }
          
          const mount = streamUrl.includes('/callshopradio-wien') ? '/callshopradio-wien' : '/callshopradio';
          let source = sources.find(s => s.listenurl?.includes(mount) || s.mount?.includes(mount)) || sources[0];
          
          if (source?.title && source.title.trim()) {
            const nowPlaying = source.title.trim();
            if (isValidMetadata({ display: nowPlaying })) {
              return {
                source: 'callshop-radio',
                display: nowPlaying,
                artist: null,
                title: null,
                raw: source,
                confidence: 0.8,
                cacheTtl: 15
              };
            }
          }
        }
      } catch (e) {
        // Continue to other methods
      }
    }
    
    // Special handling for Radio King streams
    if (streamUrl.includes('radioking.com')) {
      const radioIdMatch = streamUrl.match(/radio\/(\d+)/);
      if (radioIdMatch) {
        const radioId = radioIdMatch[1];
        const radioKingEndpoints = [
          `https://www.radioking.com/api/radio/${radioId}/track/current`,
          `https://api.radioking.com/widget/radio/${radioId}`,
          `https://www.radioking.com/api/radio/${radioId}`,
          `${urlObj.protocol}//${urlObj.host}/api/radio/${radioId}/track/current`
        ];
        
        for (const endpoint of radioKingEndpoints) {
          try {
            const response = await fetchWithTimeout(endpoint, {}, 3000);
            
            if (response.ok) {
              const data = await response.json();
              const parsed = parseArtistTitle(
                data.title || data.track?.title || data.track?.name || '',
                data.artist || data.track?.artist || '',
                data.title || data.track?.title || data.track?.name || ''
              );
              
              if (parsed && isValidMetadata({ display: parsed })) {
                return {
                  source: 'radioking',
                  display: parsed,
                  artist: data.artist || data.track?.artist || null,
                  title: data.title || data.track?.title || data.track?.name || null,
                  raw: data,
                  confidence: 0.8,
                  cacheTtl: 15
                };
              }
            }
          } catch (e) {
            continue;
          }
        }
      }
    }
    
    // Try common metadata endpoints based on station URL
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
        const response = await fetchWithTimeout(endpoint, {}, 3000);
        if (!response.ok) continue;
        
        const data = await response.json();
        const parsed = parseStationMetadata(data);
        
        if (parsed && isValidMetadata({ display: parsed })) {
          return {
            source: 'generic-api',
            display: parsed,
            artist: null,
            title: null,
            raw: { data, endpoint },
            confidence: 0.7,
            cacheTtl: 15
          };
        }
      } catch (error) {
        continue;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Radio-Browser API metadata fallback
async function fetchRadioBrowserMetadata(station) {
  try {
    if (!station.stationId) return null;
    
    const response = await fetchWithTimeout(`https://de1.api.radio-browser.info/json/stations/byuuid/${station.stationId}`);
    if (!response.ok) throw new Error(`Radio-Browser API error: ${response.status}`);
    
    const stations = await response.json();
    const stationInfo = stations[0];
    
    if (stationInfo) {
      // Check for any recently updated info
      const lastChanged = new Date(stationInfo.lastchangetime_iso8601);
      const isRecent = (Date.now() - lastChanged.getTime()) < 3600000; // Within last hour
      
      if (isRecent && stationInfo.lastcheckok === 1) {
        let nowPlaying = null;
        
        // Sometimes stations update their name to include current show/track
        if (stationInfo.name && stationInfo.name.length > 5) {
          nowPlaying = stationInfo.name;
        }
        
        if (nowPlaying && isValidMetadata({ display: nowPlaying })) {
          return {
            source: 'radio-browser',
            display: nowPlaying,
            artist: null,
            title: null,
            raw: stationInfo,
            confidence: 0.5,
            cacheTtl: 60
          };
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Radio-Browser metadata fetch failed:', error);
    return null;
  }
}

// Station info fallback
async function fetchStationInfoFallback(station) {
  try {
    if (!station.name || station.name.toLowerCase().includes('untitled') || 
        station.name.toLowerCase().includes('unknown')) {
      return null;
    }
    
    const name = station.name.trim();
    
    // Skip generic station names
    const genericPatterns = [
      /^radio\s+\d+$/i,
      /^fm\s+\d+/i,
      /^station\s+/i,
      /^\d+\.\d+\s*fm$/i
    ];
    
    const isGeneric = genericPatterns.some(pattern => pattern.test(name));
    
    if (!isGeneric && name.length > 5 && isValidMetadata({ display: name })) {
      return {
        source: 'station-info',
        display: name,
        artist: null,
        title: null,
        raw: station,
        confidence: 0.3,
        cacheTtl: 120
      };
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Main metadata fetching function
async function fetchMetadata({ streamUrl, stationId, homepage, country }) {
  // Check for HLS streams - these should be handled client-side
  if (streamUrl.includes('.m3u8')) {
    return {
      ok: false,
      reason: 'hls-client'
    };
  }
  
  const station = { stationId, url: streamUrl, homepage, country };
  const strategies = [];
  
  try {
    // Strategy selection based on hostname/URL patterns
    if (streamUrl.includes('stream-relay-geo.ntslive.net')) {
      strategies.push(() => fetchNTSMetadata(streamUrl, stationId));
    }
    
    if (streamUrl.includes('cashmereradio.airtime.pro')) {
      strategies.push(() => fetchCashmereMetadata());
    } else if (streamUrl.includes('.out.airtime.pro')) {
      strategies.push(() => fetchAirtimeProMetadata(streamUrl));
    }
    
    // Add concurrent strategies for all streams
    const urlObj = new URL(streamUrl);
    const host = urlObj.host;
    
    // Icecast status endpoints
    const icecastEndpoints = [
      `${urlObj.protocol}//${host}/status-json.xsl`,
      `${urlObj.protocol}//${host}/status.json`,
      `${urlObj.protocol}//${host}/stats.json`,
      `${urlObj.protocol}//${host}/status?json=1`
    ];
    strategies.push(() => fetchIcecastMetadata(icecastEndpoints, urlObj.pathname));
    
    // ICY metadata
    strategies.push(() => fetchICYMetadata(streamUrl));
    
    // Generic API endpoints
    strategies.push(() => fetchGenericMetadata(streamUrl, station));
    
    // Radio Browser fallback
    if (stationId) {
      strategies.push(() => fetchRadioBrowserMetadata(station));
    }
    
    // Station info fallback
    strategies.push(() => fetchStationInfoFallback(station));
    
    // Execute strategies concurrently
    const promises = strategies.map(strategy => 
      strategy().catch(err => {
        console.error('Strategy failed:', err);
        return null;
      })
    );
    
    const result = await firstNonNullResult(promises);
    
    if (result && result.display) {
      return {
        source: result.source,
        display: result.display,
        artist: result.artist,
        title: result.title,
        raw: result.raw,
        cacheTtl: result.cacheTtl || 15
      };
    }
    
    return {
      ok: false,
      reason: 'no-metadata'
    };
    
  } catch (error) {
    console.error('Metadata fetch failed:', error);
    return {
      ok: false,
      reason: 'upstream-error'
    };
  }
}

module.exports = {
  fetchMetadata,
  cleanNowPlaying,
  parseArtistTitle,
  parseStationMetadata,
  isValidMetadata
};