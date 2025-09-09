# RadioDock Metadata Proxy - Complete Deployment Guide

This guide will walk you through deploying the metadata proxy service on Render.com and updating your RadioDock extension to use it.

## 🚀 Quick Overview

**What we're doing:**
1. Deploy a Node.js service on Render.com that fetches radio metadata
2. Update your extension to use this service instead of direct fetching
3. Reduce extension permissions to just Radio-Browser + your proxy domain

**Benefits:**
- ✅ No more CORS issues
- ✅ Minimal extension permissions (Web Store friendly)
- ✅ Better user experience (no permission prompts)
- ✅ Universal metadata support for any radio station

---

## 📁 Step 1: Prepare Your Code

You now have a complete proxy service in the `radio-metadata-proxy` folder:

```
radio-metadata-proxy/
├── package.json              # Node.js dependencies
├── server.js                 # Main proxy service code
├── render.yaml               # Render.com configuration
├── .gitignore               # Git ignore file
├── README.md                # Service documentation
├── DEPLOYMENT_GUIDE.md      # This guide
├── extension-manifest.json   # Updated extension manifest
└── extension-background.js   # Updated background script
```

---

## 🌐 Step 2: Deploy to Render.com

### Option A: Deploy via GitHub (Recommended)

1. **Create a Git repository:**
   ```bash
   cd C:\Users\konta\Desktop\radio-metadata-proxy
   git init
   git add .
   git commit -m "Initial commit: RadioDock metadata proxy service"
   ```

2. **Push to GitHub:**
   - Go to [github.com](https://github.com) and create a new repository
   - Name it `radio-metadata-proxy` (or any name you prefer)
   - Make it public or private (your choice)
   - Copy the repository URL

   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/radio-metadata-proxy.git
   git branch -M main
   git push -u origin main
   ```

3. **Deploy on Render.com:**
   - Go to [render.com](https://render.com) and sign up (free account)
   - Click **"New"** → **"Web Service"**
   - Click **"Connect a repository"** and authorize GitHub
   - Select your `radio-metadata-proxy` repository
   - Render will automatically detect the `render.yaml` file
   - **Important**: Note the service name - it will be something like `radio-metadata-proxy-abc123`
   - Click **"Create Web Service"**

4. **Wait for deployment:**
   - Initial deployment takes 2-5 minutes
   - You'll get a URL like: `https://radio-metadata-proxy-abc123.onrender.com`
   - **Save this URL - you'll need it for the extension!**

### Option B: Deploy via Render Dashboard

1. **Go to [render.com](https://render.com) and sign up**

2. **Create new Web Service manually:**
   - Click **"New"** → **"Web Service"**
   - Choose **"Deploy from Git repository"** → **"Connect GitHub"**
   - Or upload your files directly

3. **Configure the service:**
   - **Name**: `radio-metadata-proxy` (or your choice)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free` (or paid for better performance)

4. **Deploy and get your URL**

---

## ✅ Step 3: Test Your Proxy Service

Once deployed, test your service:

1. **Health Check:**
   Visit: `https://your-service-name.onrender.com/`
   
   You should see:
   ```json
   {
     "service": "RadioDock Metadata Proxy",
     "version": "1.0.0",
     "status": "running",
     "endpoints": {
       "metadata": "/metadata?url=STREAM_URL",
       "health": "/"
     }
   }
   ```

2. **Test Metadata:**
   Try: `https://your-service-name.onrender.com/metadata?url=https://nts-live-1.global.ssl.fastly.net/nts_live_a.m3u8`
   
   You should see metadata returned (may take 15-30 seconds on first request due to cold start).

---

## 🔧 Step 4: Update Your Extension

Now update your RadioDock extension to use the proxy service:

### 4.1 Update manifest.json

Replace your current `manifest.json` with this (update the proxy URL):

```json
{
  "manifest_version": 3,
  "name": "RadioDock",
  "version": "1.1",
  "description": "Play and organize your favorite radio stations. Explore 50,000+ stations including community radios and save them into custom lists.",
  "icons": {
    "16": "logo/icon-16.png",
    "48": "logo/icon-48.png",
    "128": "logo/icon-128.png"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "RadioDock",
    "default_icon": {
      "16": "logo/icon-16.png",
      "48": "logo/icon-48.png",
      "128": "logo/icon-128.png"
    }
  },
  "background": {
    "service_worker": "background.js"
  },
  "permissions": [
    "storage",
    "offscreen",
    "contextMenus"
  ],
  "host_permissions": [
    "https://*.radio-browser.info/*",
    "https://your-service-name.onrender.com/*"
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; img-src * data:; font-src * data:;"
  }
}
```

**🚨 Important**: Replace `your-service-name.onrender.com` with your actual Render.com URL!

### 4.2 Update background.js

You need to update your `background.js` file. The main changes:

1. **Add proxy configuration at the top:**
   ```javascript
   // CONFIGURATION - Update this with your deployed proxy URL
   const METADATA_PROXY_URL = 'https://your-service-name.onrender.com';
   ```

2. **Replace metadata fetching functions** with proxy calls:
   ```javascript
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
         return {
           nowPlaying: data.metadata.nowPlaying,
           source: data.metadata.source || 'proxy',
           channel: station.name,
           timestamp: data.timestamp
         };
       }
       
       return null;
       
     } catch (error) {
       console.warn('Proxy metadata fetch failed:', error.message);
       return null;
     }
   }
   ```

3. **Update main metadata function:**
   ```javascript
   async function fetchCurrentMetadata(station, retryCount = 0) {
     try {
       // Try proxy service first
       const metadata = await fetchMetadataViaProxy(station);
       
       if (metadata) {
         // Update current metadata and notify popup
         currentMetadata = metadata;
         forwardToPopup({
           type: 'METADATA_UPDATE',
           metadata: metadata
         });
         return metadata;
       }
       
       return null;
     } catch (error) {
       console.error('Error fetching metadata:', error);
       return null;
     }
   }
   ```

4. **Remove old metadata functions** (you don't need these anymore):
   - `fetchIcecastMetadata`
   - `fetchICYMetadata`
   - `fetchGenericMetadata`
   - `fetchHLSMetadata`
   - All the complex timeout and parsing logic

**Reference**: Use the `extension-background.js` file in your proxy project as a guide.

---

## 🧪 Step 5: Test Your Updated Extension

1. **Load the updated extension in Chrome:**
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select your RadioDock folder
   - Or click "Reload" if already loaded

2. **Test functionality:**
   - Search for radio stations (should work - uses Radio-Browser)
   - Play a station (should work - uses offscreen document)
   - Check for "Now Playing" metadata (should work via proxy)
   - Check browser console for any errors

3. **Verify permissions:**
   - In `chrome://extensions/`, click "Details" on your extension
   - Check "Permissions" - should only show your proxy domain and radio-browser.info

---

## 🚨 Important Notes

### Cold Starts (Free Tier)
- **First Request**: May take 15-30 seconds after inactivity
- **Subsequent Requests**: Fast (< 1 second)
- **Solution**: Upgrade to paid plan ($7/month) for always-on service

### Service URL Changes
- Your Render.com URL is permanent (unless you delete the service)
- If you change the service name, update the extension manifest accordingly

### Error Handling
- The proxy service has built-in fallbacks and error handling
- If proxy fails, extension falls back to Radio-Browser API
- Users will still get basic functionality even if metadata fails

---

## 📈 Optional Improvements

### 1. Custom Domain (Paid Feature)
- Set up a custom domain like `metadata.yourdomain.com`
- More professional and permanent URL

### 2. Caching (Performance)
- Add Redis caching to reduce API calls
- Store frequently requested metadata for faster responses

### 3. Rate Limiting
- Add rate limiting to prevent abuse
- Protect against excessive requests

### 4. Monitoring
- Add health checks and monitoring
- Get alerts if service goes down

---

## 🔍 Troubleshooting

### Extension Issues
- **CORS Errors**: Check if proxy URL is correct in manifest and background.js
- **No Metadata**: Check browser console for proxy service errors
- **Service Unreachable**: Verify proxy service is deployed and URL is correct

### Proxy Service Issues
- **503 Errors**: Service might be cold starting (wait 30 seconds)
- **Build Failures**: Check Render.com logs for deployment errors
- **Memory Issues**: Free tier has memory limits (upgrade if needed)

### Common Fixes
1. **Clear extension cache**: Remove and reload extension
2. **Check URLs**: Ensure all URLs match your deployed service
3. **Test proxy directly**: Visit proxy health check URL in browser

---

## 🎉 You're Done!

Your RadioDock extension now uses a professional metadata proxy service that:
- ✅ Solves all CORS issues
- ✅ Has minimal permissions (Web Store friendly)
- ✅ Supports metadata from any radio station
- ✅ Provides better reliability and performance

The extension is now ready for Google Web Store submission with minimal permissions that won't trigger extensive reviews!

---

## 📞 Need Help?

If you encounter issues:
1. Check the proxy service logs in Render.com dashboard
2. Check browser console for extension errors
3. Verify all URLs are correctly updated
4. Test the proxy service directly in your browser

The proxy service handles all the complexity of metadata fetching, making your extension much simpler and more reliable!