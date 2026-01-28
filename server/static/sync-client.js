/**
 * BabyTrack WebSocket Sync Client
 * 
 * Replaces JSONBin.io sync with real-time WebSocket connection to babytrackd server.
 * 
 * Reliability guarantees:
 * - Entries are added to pendingQueue before send attempt
 * - Entries remain in pendingQueue until server acks them
 * - On reconnect, all pending entries are resent
 * - pendingQueue is persisted to localStorage
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
    
    // Pending queue: entries awaiting server ack
    // Map of id -> {msg, addedAt}
    this.pendingEntries = new Map();
    this.loadPendingQueue();
    
    // Pending config (only one config at a time)
    this.pendingConfig = null;
    this.loadPendingConfig();
    
    // Callbacks
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.onEntry = options.onEntry || (() => {});
    this.onConfig = options.onConfig || (() => {});
    this.onPresence = options.onPresence || (() => {});
    this.onInit = options.onInit || (() => {});
    this.onError = options.onError || (() => {});
    
    // Cursor (seq) for incremental sync - highest seq received from server
    this.cursor = parseInt(localStorage.getItem('sync-cursor') || '0', 10);
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
        
        // Send initial sync_request with current cursor
        this.sendSyncRequest();
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
  
  // Safe send that catches errors
  safeSend(msg) {
    if (!this.connected || !this.ws) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error('[Sync] Send failed:', err);
      return false;
    }
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
        case 'entry_ack':
          this.handleEntryAck(msg);
          break;
        case 'config':
          this.handleConfigAck();
          this.onConfig(msg.data);
          break;
        case 'presence':
          this.onPresence(msg.members || []);
          break;
        case 'sync':
          this.handleSync(msg);
          break;
        case 'sync_response':
          this.handleSyncResponse(msg);
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
    
    // Track the highest seq received
    if (msg.entries) {
      for (const entry of msg.entries) {
        if (entry.seq > this.cursor) {
          this.cursor = entry.seq;
        }
        // Remove from pending if server already has it
        this.pendingEntries.delete(entry.id);
      }
      this.saveCursor();
      this.savePendingQueue();
    }
    
    this.onInit(msg.entries || [], msg.config || {});
    
    // After init, flush any pending entries
    this.flushPendingQueue();
  }
  
  handleEntry(msg) {
    const entry = msg.entry;
    
    // For delete actions, server sends id at message level, not in entry
    if (msg.action === 'delete') {
      // Update cursor from message seq
      if (msg.seq > this.cursor) {
        this.cursor = msg.seq;
        this.saveCursor();
      }
      // Pass an object with the id to the handler
      this.onEntry(msg.action, { id: msg.id });
      return;
    }
    
    // Track seq from received entry
    if (entry && entry.seq > this.cursor) {
      this.cursor = entry.seq;
      this.saveCursor();
    }
    
    this.onEntry(msg.action, entry);
  }
  
  handleEntryAck(msg) {
    // Entry was persisted by server, remove from pending queue
    console.log('[Sync] Entry ack:', msg.id, 'seq:', msg.seq);
    
    // Remove from pending - this is the key reliability mechanism
    if (this.pendingEntries.has(msg.id)) {
      this.pendingEntries.delete(msg.id);
      this.savePendingQueue();
      console.log('[Sync] Removed from pending, remaining:', this.pendingEntries.size);
    }
    
    // Update cursor if this seq is higher
    if (msg.seq > this.cursor) {
      this.cursor = msg.seq;
      this.saveCursor();
    }
  }
  
  handleConfigAck() {
    // Config was persisted, clear pending
    if (this.pendingConfig) {
      this.pendingConfig = null;
      this.savePendingConfig();
      console.log('[Sync] Config ack received');
    }
  }
  
  handleSync(msg) {
    // Legacy: Response to incremental sync request
    if (msg.entries) {
      for (const entry of msg.entries) {
        // Use appropriate action based on deleted flag
        const action = entry.deleted ? 'delete' : 'add';
        this.onEntry(action, entry);
        if (entry.seq > this.cursor) {
          this.cursor = entry.seq;
        }
        // Remove from pending if server has it
        this.pendingEntries.delete(entry.id);
      }
      this.saveCursor();
      this.savePendingQueue();
    }
  }
  
  handleSyncResponse(msg) {
    // New cursor-based sync response
    console.log('[Sync] Received sync_response:', msg.entries?.length || 0, 'entries, has_more:', msg.has_more);
    
    if (msg.entries) {
      for (const entry of msg.entries) {
        // Use appropriate action based on deleted flag
        const action = entry.deleted ? 'delete' : 'add';
        this.onEntry(action, entry);
        // Remove from pending if server already has it
        this.pendingEntries.delete(entry.id);
      }
    }
    
    // Update cursor from response
    if (msg.cursor > this.cursor) {
      this.cursor = msg.cursor;
      this.saveCursor();
    }
    this.savePendingQueue();
    
    // If more data available, request next page
    if (msg.has_more) {
      this.sendSyncRequest();
    } else {
      // Sync complete, now flush pending queue
      console.log('[Sync] Initial sync complete, flushing pending queue');
      this.flushPendingQueue();
    }
  }
  
  sendSyncRequest() {
    if (!this.connected || !this.ws) return;
    
    console.log('[Sync] Sending sync_request with cursor:', this.cursor);
    this.safeSend({
      type: 'sync_request',
      cursor: this.cursor,
      limit: 500
    });
  }
  
  saveCursor() {
    localStorage.setItem('sync-cursor', this.cursor.toString());
  }
  
  // Send entry to server - always queues first, then tries to send
  sendEntry(action, entry) {
    const entryId = entry.id;
    if (!entryId) {
      console.error('[Sync] Entry missing id:', entry);
      return;
    }
    
    let msg;
    if (action === 'delete') {
      msg = {
        type: 'entry',
        action: action,
        id: entryId
      };
    } else {
      msg = {
        type: 'entry',
        action: action,
        entry: entry
      };
    }
    
    // Always add to pending queue first (reliability guarantee)
    this.pendingEntries.set(entryId, {
      msg: msg,
      addedAt: Date.now()
    });
    this.savePendingQueue();
    
    // Try to send immediately if connected
    if (this.connected && this.ws) {
      this.safeSend(msg);
    } else {
      console.log('[Sync] Queued entry for later sync:', entryId);
    }
  }
  
  // Send config update - queues until acked
  sendConfig(config) {
    // Validate the config structure before sending
    const validatedConfig = config.map(group => ({
      category: group.category,
      stateful: group.stateful || false,
      buttons: group.buttons.map(btn => ({
        value: btn.value,
        label: btn.label,
        emoji: btn.emoji,
        countDaily: btn.countDaily || false
      }))
    }));

    const msg = {
      type: 'config',
      data: validatedConfig
    };
    
    // Queue the config
    this.pendingConfig = {
      msg: msg,
      addedAt: Date.now()
    };
    this.savePendingConfig();
    
    // Try to send immediately if connected
    if (this.connected && this.ws) {
      this.safeSend(msg);
    } else {
      console.log('[Sync] Queued config for later sync');
    }
  }
  
  // Pending queue management
  loadPendingQueue() {
    try {
      const stored = localStorage.getItem('sync-pending-queue');
      if (stored) {
        const arr = JSON.parse(stored);
        this.pendingEntries = new Map(arr);
      }
    } catch (_e) {
      this.pendingEntries = new Map();
    }
  }
  
  savePendingQueue() {
    const arr = Array.from(this.pendingEntries.entries());
    localStorage.setItem('sync-pending-queue', JSON.stringify(arr));
  }
  
  loadPendingConfig() {
    try {
      const stored = localStorage.getItem('sync-pending-config');
      this.pendingConfig = stored ? JSON.parse(stored) : null;
    } catch (_e) {
      this.pendingConfig = null;
    }
  }
  
  savePendingConfig() {
    if (this.pendingConfig) {
      localStorage.setItem('sync-pending-config', JSON.stringify(this.pendingConfig));
    } else {
      localStorage.removeItem('sync-pending-config');
    }
  }
  
  flushPendingQueue() {
    if (this.pendingEntries.size === 0 && !this.pendingConfig) return;
    if (!this.connected || !this.ws) return;
    
    console.log('[Sync] Flushing', this.pendingEntries.size, 'pending entries');
    
    // Send all pending entries
    for (const [id, pending] of this.pendingEntries) {
      console.log('[Sync] Resending pending entry:', id);
      this.safeSend(pending.msg);
    }
    
    // Send pending config if any
    if (this.pendingConfig) {
      console.log('[Sync] Resending pending config');
      this.safeSend(this.pendingConfig.msg);
    }
    
    // Note: we don't clear the queue here - entries are only removed on ack
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
  
  // Get pending count for UI/debugging
  getPendingCount() {
    return this.pendingEntries.size + (this.pendingConfig ? 1 : 0);
  }
}

// Export for use in HTML
if (typeof window !== 'undefined') {
  window.SyncClient = SyncClient;
}
