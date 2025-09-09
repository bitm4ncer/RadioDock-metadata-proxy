// RadioDock Background Script - Updated to use Metadata Proxy
// Replace your existing background.js with this version

importScripts('metadata-strategies.js');

// CONFIGURATION - Update this with your deployed proxy URL
const METADATA_PROXY_URL = 'https://your-service-name.onrender.com';

// Utility function to detect CORS errors (keep for fallback cases)
function isCorsError(error) {
  return error && error.message && (
    error.message.includes('CORS') || 
    error.message.includes('Access-Control') ||
    error.message.includes('Cross-Origin') ||
    (error.name === 'TypeError' && error.message.includes('fetch')) ||
    (error.name === 'TypeError' && error.message.includes('Failed to fetch'))
  );
}

let isPlaying = false;
let isPaused = false;
let offscreenDocument = null;
let currentStation = null;
let favorites = [];
let contextMenuUpdateTimeout = null;

// Now Playing metadata system
let currentMetadata = null;
let metadataUpdateInterval = null;
let metadataFetchers = new Map();

// ... [Keep all your existing chrome.runtime.onInstalled, loadCurrentStation, etc. handlers] ...

// UPDATED: Main metadata fetching function using proxy
async function fetchCurrentMetadata(station, retryCount = 0) {
  const maxRetries = 2;
  const retryDelay = 1000 * (retryCount + 1); // Exponential backoff: 1s, 2s, 3s
  
  try {
    let metadata = null;
    
    // Try proxy service first
    metadata = await fetchMetadataViaProxy(station);
    
    // If proxy fails, fall back to direct methods for specific known services
    if (!metadata) {
      console.warn('Proxy metadata failed, trying fallback methods');
      metadata = await fetchMetadataFallback(station);
    }
    
    if (metadata) {
      // Update current metadata
      const prevMetadata = currentMetadata;
      currentMetadata = metadata;
      
      // Only send update if metadata actually changed
      const metadataChanged = !prevMetadata || 
                            prevMetadata.nowPlaying !== metadata.nowPlaying ||
                            prevMetadata.source !== metadata.source;
      
      if (metadataChanged) {
        console.log('Metadata updated:', metadata);
        
        // Send to popup
        forwardToPopup({
          type: 'METADATA_UPDATE',
          metadata: metadata
        });
      }
      
      return metadata;
    }
    
    // If no metadata found, clear current metadata
    if (currentMetadata) {
      currentMetadata = null;
      forwardToPopup({
        type: 'METADATA_UPDATE',
        metadata: null
      });
    }
    
    return null;
    
  } catch (error) {
    console.error(`Error fetching metadata (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
    
    // Retry logic
    if (retryCount < maxRetries && !error.name?.includes('AbortError')) {
      console.log(`Retrying metadata fetch in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return fetchCurrentMetadata(station, retryCount + 1);
    }
    
    // Clear metadata on persistent failure
    if (currentMetadata) {
      currentMetadata = null;
      forwardToPopup({
        type: 'METADATA_UPDATE',
        metadata: null
      });
    }
    
    return null;
  }
}

// NEW: Fetch metadata via proxy service
async function fetchMetadataViaProxy(station) {
  if (!station || !station.url) return null;
  
  try {
    const proxyUrl = `${METADATA_PROXY_URL}/metadata?url=${encodeURIComponent(station.url)}`;
    
    const response = await fetch(proxyUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'RadioDock-Extension/1.0'
      },
      cache: 'no-store'
    });
    
    if (!response.ok) {
      throw new Error(`Proxy responded with ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.success && data.metadata && data.metadata.nowPlaying) {
      console.log(`Metadata fetched via proxy (${data.metadata.source}):`, data.metadata.nowPlaying);
      return {
        nowPlaying: data.metadata.nowPlaying,
        source: data.metadata.source || 'proxy',
        channel: station.name,
        timestamp: data.timestamp
      };
    }
    
    return null;
    
  } catch (error) {
    if (isCorsError(error)) {
      console.warn(`Proxy service blocked by CORS. Check if ${METADATA_PROXY_URL} is accessible.`);
    } else {
      console.warn('Proxy metadata fetch failed:', error.message);
    }
    return null;
  }
}

// UPDATED: Fallback metadata fetching for critical services only
async function fetchMetadataFallback(station) {
  if (!station || !station.url) return null;
  
  try {
    // Only try Radio-Browser API as fallback (we have permission for this)
    if (station.id) {
      const metadata = await fetchRadioBrowserMetadata(station);
      if (metadata) {
        return metadata;
      }
    }
    
    console.log('No fallback metadata available');
    return null;
    
  } catch (error) {
    console.warn('Fallback metadata fetch failed:', error.message);
    return null;
  }
}

// KEEP: Radio-Browser API metadata (direct access - we have permission)
async function fetchRadioBrowserMetadata(station) {
  try {
    if (!station.id) return null;
    
    const response = await fetch(`https://de1.api.radio-browser.info/json/stations/byuuid/${station.id}`, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'RadioDock/1.0'
      }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const stationData = Array.isArray(data) ? data[0] : data;
    
    if (stationData) {
      // Use station info as basic metadata
      const nowPlaying = `${stationData.name || station.name || 'Radio Station'}`;
      
      return {
        nowPlaying: nowPlaying,
        source: 'radiobrowser',
        channel: stationData.name || station.name,
        lastChecked: new Date().toISOString()
      };
    }
    
    return null;
  } catch (error) {
    console.error('Radio-Browser metadata fetch failed:', error);
    return null;
  }
}

// SIMPLIFIED: Create metadata fetcher (now just returns proxy config)
function createMetadataFetcher(station) {
  try {
    if (!station || !station.url) return null;
    
    return {
      station: station,
      sources: [
        { type: 'proxy', url: station.url }
      ],
      cleanup: () => {} // No cleanup needed for proxy approach
    };
  } catch (error) {
    console.error('Error creating metadata fetcher:', error);
    return null;
  }
}

// SIMPLIFIED: Metadata fetching with proxy
async function fetchFromSourcesFast(fetcher, station) {
  try {
    // Just use the proxy - much simpler!
    return await fetchMetadataViaProxy(station);
  } catch (e) {
    console.error('Error in metadata fetching:', e);
    return null;
  }
}

// Keep all your other existing functions:
// - handlePlayStation, handlePauseStation, etc.
// - loadCurrentStation, updateContextMenus
// - sendToOffscreen, forwardToPopup
// - All the chrome.runtime.onMessage handlers
// Just replace the metadata fetching parts with the above functions

/*
INTEGRATION NOTES:

1. Replace your existing background.js with this version
2. Update METADATA_PROXY_URL with your deployed service URL
3. Update your manifest.json host_permissions to only include:
   - "https://*.radio-browser.info/*" 
   - "https://your-service-name.onrender.com/*"
4. Remove all the complex metadata fetching functions:
   - fetchIcecastMetadata
   - fetchICYMetadata  
   - fetchGenericMetadata
   - fetchHLSMetadata
   - All the timeout and retry logic

The proxy service handles all of that complexity server-side!
*/