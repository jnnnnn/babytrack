/**
 * BabyTrack WebSocket Sync Client
 * 
 * Replaces JSONBin.io sync with real-time WebSocket connection to babytrackd server.
 * Supports offline queueing and automatic reconnection.
 */

class SyncClient {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || this.detectServerUrl();
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    
    // Offline queue for entries created while disconnected
    this.offlineQueue = [];
    this.loadOfflineQueue();
    
    // Callbacks
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.onEntry = options.onEntry || (() => {});
    this.onConfig = options.onConfig || (() => {});
    this.onPresence = options.onPresence || (() => {});
    this.onInit = options.onInit || (() => {});
    this.onError = options.onError || (() => {});
    
    // Last update timestamp for incremental sync
    this.lastUpdatedAt = parseInt(localStorage.getItem('sync-last-updated') || '0', 10);
  }
  
  detectServerUrl() {
    // If on same origin as server, use relative path
    // Otherwise, look for server URL in localStorage or URL params
    const params = new URLSearchParams(window.location.search);
    const urlServer = params.get('server');
    if (urlServer) {
      localStorage.setItem('sync-server', urlServer);
      return urlServer;
    }
    
    const stored = localStorage.getItem('sync-server');
    if (stored) return stored;
    
    // Default: assume server is on same host
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  
  connect() {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    
    try {
      this.ws = new WebSocket(`${this.serverUrl}/ws`);
      
      this.ws.onopen = () => {
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        console.log('[Sync] Connected to server');
        this.onConnect();
        
        // Flush offline queue
        this.flushOfflineQueue();
      };
      
      this.ws.onclose = () => {
        this.connected = false;
        this.connecting = false;
        console.log('[Sync] Disconnected from server');
        this.onDisconnect();
        this.scheduleReconnect();
      };
      
      this.ws.onerror = (err) => {
        console.error('[Sync] WebSocket error:', err);
        this.onError(err);
      };
      
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
    } catch (err) {
      this.connecting = false;
      console.error('[Sync] Failed to connect:', err);
      this.scheduleReconnect();
    }
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connecting = false;
  }
  
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[Sync] Max reconnection attempts reached');
      return;
    }
    
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    console.log(`[Sync] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => this.connect(), delay);
  }
  
  handleMessage(data) {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'init':
          this.handleInit(msg);
          break;
        case 'entry':
          this.handleEntry(msg);
          break;
        case 'config':
          // Process the new configuration structure
          this.onConfig(msg.data);
          console.log('Received config:', msg.data);
          break;
        case 'presence':
          this.onPresence(msg.members || []);
          break;
        case 'sync':
          this.handleSync(msg);
          break;
        case 'pong':
          // Heartbeat response
          break;
        default:
          console.log('[Sync] Unknown message type:', msg.type);
      }
    } catch (err) {
      console.error('[Sync] Failed to parse message:', err, data);
    }
  }
  
  handleInit(msg) {
    console.log('[Sync] Received init with', msg.entries?.length || 0, 'entries');
    
    // Track the latest updated_at
    if (msg.entries) {
      for (const entry of msg.entries) {
        if (entry.updated_at > this.lastUpdatedAt) {
          this.lastUpdatedAt = entry.updated_at;
        }
      }
      this.saveLastUpdatedAt();
    }
    
    this.onInit(msg.entries || [], msg.config || {});
  }
  
  handleEntry(msg) {
    const entry = msg.entry;
    
    // Track updated_at
    if (entry && entry.updated_at > this.lastUpdatedAt) {
      this.lastUpdatedAt = entry.updated_at;
      this.saveLastUpdatedAt();
    }
    
    this.onEntry(msg.action, entry);
  }
  
  handleSync(msg) {
    // Response to incremental sync request
    if (msg.entries) {
      for (const entry of msg.entries) {
        // Use appropriate action based on deleted flag
        const action = entry.deleted ? 'delete' : 'add';
        this.onEntry(action, entry);
        if (entry.updated_at > this.lastUpdatedAt) {
          this.lastUpdatedAt = entry.updated_at;
        }
      }
      this.saveLastUpdatedAt();
    }
  }
  
  saveLastUpdatedAt() {
    localStorage.setItem('sync-last-updated', this.lastUpdatedAt.toString());
  }
  
  // Send entry to server
  sendEntry(action, entry) {
    const msg = {
      type: 'entry',
      action: action,
      entry: entry
    };
    
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // Queue for later
      this.offlineQueue.push(msg);
      this.saveOfflineQueue();
      console.log('[Sync] Queued entry for later sync');
    }
  }
  
  // Convenience methods for entry operations
  addEntry(entry) {
    // Ensure entry has a UUID if not present
    if (!entry.id) {
      entry.id = this.generateUUID();
    }
    this.sendEntry('add', entry);
    return entry.id;
  }
  
  updateEntry(entry) {
    this.sendEntry('update', entry);
  }
  
  deleteEntry(id) {
    this.sendEntry('delete', { id });
  }
  
  // Send config update
  sendConfig(config) {
    if (this.connected && this.ws) {
      // Validate the config structure before sending
      const validatedConfig = config.map(group => ({
        category: group.category,
        stateful: group.stateful,
        buttons: group.buttons.map(btn => ({
          label: btn.label,
          timing: btn.timing,
          counted: btn.counted
        }))
      }));

      this.ws.send(JSON.stringify({
        type: 'config',
        data: validatedConfig
      }));
    }
  }
  
  // Request incremental sync
  requestSync(localEntries = []) {
    if (!this.connected || !this.ws) return;
    
    this.ws.send(JSON.stringify({
      type: 'sync',
      since_update: this.lastUpdatedAt,
      entries: localEntries
    }));
  }
  
  // Offline queue management
  loadOfflineQueue() {
    try {
      const stored = localStorage.getItem('sync-offline-queue');
      this.offlineQueue = stored ? JSON.parse(stored) : [];
    } catch (e) {
      this.offlineQueue = [];
    }
  }
  
  saveOfflineQueue() {
    localStorage.setItem('sync-offline-queue', JSON.stringify(this.offlineQueue));
  }
  
  flushOfflineQueue() {
    if (this.offlineQueue.length === 0) return;
    
    console.log('[Sync] Flushing', this.offlineQueue.length, 'queued messages');
    
    for (const msg of this.offlineQueue) {
      if (this.ws && this.connected) {
        this.ws.send(JSON.stringify(msg));
      }
    }
    
    this.offlineQueue = [];
    this.saveOfflineQueue();
  }
  
  // Generate a UUID for entries
  generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  
  // Start heartbeat
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }
  
  // Check if we have server connection
  isConnected() {
    return this.connected;
  }
  
  // Get connection status for UI
  getStatus() {
    if (this.connected) return 'connected';
    if (this.connecting) return 'connecting';
    return 'disconnected';
  }
}

// Export for use in HTML
if (typeof window !== 'undefined') {
  window.SyncClient = SyncClient;
}
