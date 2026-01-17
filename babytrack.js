// BabyTrack Application JavaScript
// See docs/button-groups.md for button group specification

// ==================== Error Forwarding ====================
(function setupErrorForwarding() {
  const logQueue = [];
  let flushTimeout = null;

  function queueLog(level, message, data) {
    const params = new URLSearchParams(window.location.search);
    logQueue.push({
      level,
      message,
      data,
      url: window.location.href,
      family: params.get('family') || ''
    });

    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(flushLogs, 100);
  }

  function flushLogs() {
    if (logQueue.length === 0) return;
    const toSend = logQueue.splice(0, logQueue.length);
    fetch('/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toSend)
    }).catch(() => {});
  }

  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;

  console.error = function (...args) {
    queueLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    origError.apply(console, args);
  };

  console.warn = function (...args) {
    queueLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    origWarn.apply(console, args);
  };

  console.log = function (...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.includes('[Sync]') || msg.includes('[WS Sync]')) {
      queueLog('info', msg);
    }
    origLog.apply(console, args);
  };

  window.addEventListener('error', (e) => {
    queueLog('error', `Uncaught: ${e.message} at ${e.filename}:${e.lineno}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    queueLog('error', `Unhandled promise rejection: ${e.reason}`);
  });
})();

// ==================== Database ====================
let db = null;

async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('BabyLogDB', 3);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const objectStore = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        objectStore.createIndex('timestamp', 'ts', { unique: false });
      }

      if (oldVersion < 2) {
        const transaction = event.target.transaction;
        const objectStore = transaction.objectStore('entries');

        objectStore.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (cursor) {
            const entry = cursor.value;
            if (!entry.hasOwnProperty('deleted')) {
              entry.deleted = false;
              cursor.update(entry);
            }
            cursor.continue();
          }
        };
      }

      if (oldVersion < 3) {
        const transaction = event.target.transaction;
        const objectStore = transaction.objectStore('entries');

        if (!objectStore.indexNames.contains('updated')) {
          objectStore.createIndex('updated', 'updated', { unique: false });
        }

        objectStore.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (cursor) {
            const entry = cursor.value;
            if (!entry.hasOwnProperty('updated')) {
              entry.updated = entry.ts;
              cursor.update(entry);
            }
            cursor.continue();
          }
        };
      }
    };
  });
}

async function addEntry(type, value, ts) {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readwrite');
  const objectStore = transaction.objectStore('entries');
  const now = new Date().toISOString();

  const syncId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

  const entry = { type, value, ts, deleted: false, updated: now, syncId };
  const request = objectStore.add(entry);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      entry.id = request.result;

      if (window.syncClient && window.syncClient.isConnected()) {
        window.syncClient.sendEntry('add', {
          id: entry.syncId,
          ts: new Date(ts).getTime(),
          type: entry.type,
          value: entry.value,
          deleted: entry.deleted
        });
      }

      resolve(request.result);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function loadEntriesByDate(date) {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readonly');
  const objectStore = transaction.objectStore('entries');

  let range;
  if (date) {
    const { start, end } = getDayBounds(date);
    const expandedStart = new Date(new Date(start).getTime() - 12 * 60 * 60 * 1000).toISOString();
    const expandedEnd = new Date(new Date(end).getTime() + 12 * 60 * 60 * 1000).toISOString();
    range = IDBKeyRange.bound(expandedStart, expandedEnd);
  } else {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    range = IDBKeyRange.lowerBound(yesterday);
  }

  const request = objectStore.index('timestamp').getAll(range);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function clearAllEntries() {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readwrite');
  const objectStore = transaction.objectStore('entries');
  objectStore.clear();

  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function toggleEntryDeleted(entryId, shouldDelete) {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readwrite');
  const objectStore = transaction.objectStore('entries');

  return new Promise((resolve, reject) => {
    const getRequest = objectStore.get(entryId);
    getRequest.onsuccess = () => {
      const entry = getRequest.result;
      if (entry && entry.deleted !== shouldDelete) {
        entry.deleted = shouldDelete;
        entry.updated = new Date().toISOString();
        const updateRequest = objectStore.put(entry);
        updateRequest.onsuccess = () => {
          if (window.syncClient && window.syncClient.isConnected() && entry.syncId) {
            if (shouldDelete) {
              window.syncClient.sendEntry('delete', { id: entry.syncId });
            } else {
              window.syncClient.sendEntry('update', {
                id: entry.syncId,
                ts: new Date(entry.ts).getTime(),
                type: entry.type,
                value: entry.value,
                deleted: entry.deleted
              });
            }
          }
          resolve(entry);
        };
        updateRequest.onerror = () => reject(updateRequest.error);
      } else {
        resolve(null);
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

// ==================== Utilities ====================
function nowIso() {
  return new Date().toISOString();
}

function formatElapsedTime(timestampMs) {
  const elapsed = Math.floor((Date.now() - timestampMs) / 1000 / 60);
  const hours = Math.floor(elapsed / 60);
  const mins = elapsed % 60;
  return hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
}

function getDayBounds(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function getDayBoundsAsDate(date) {
  const { start, end } = getDayBounds(date);
  return { dayStart: new Date(start), dayEnd: new Date(end) };
}

function isEntryInDay(entry, dayStart, dayEnd) {
  const ts = new Date(entry.ts);
  return ts >= dayStart && ts <= dayEnd;
}

function filterEntriesInDay(entries, date) {
  const { dayStart, dayEnd } = getDayBoundsAsDate(date);
  return entries.filter((e) => isEntryInDay(e, dayStart, dayEnd));
}

// ==================== Tab Navigation ====================
function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach((tab) => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.remove('active');
  });
  document.getElementById(tabName + '-tab').classList.add('active');
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

// ==================== Button Display ====================

/**
 * Update a button's visual state
 * @param {HTMLElement} btn - The button element
 * @param {string} label - The button label text
 * @param {string|null} timeStr - Optional elapsed time string to display
 * @param {boolean} highlight - Whether to highlight the button as "active"
 */
function updateButtonDisplay(btn, label, timeStr = null, highlight = false) {
  if (!btn) return;
  const opacity = highlight ? '0.9' : '0.8';
  btn.style.background = highlight ? 'var(--primary)' : '';
  btn.style.color = highlight ? '#fff' : '';
  btn.innerHTML = timeStr ? `${label}<br><small style="font-size: 11px; opacity: ${opacity};">${timeStr}</small>` : label;
}

/**
 * Compute button states for a group based on entries
 * Implements the spec from docs/button-groups.md
 *
 * @param {Object} group - Button group config
 * @param {Array} categoryEntries - All non-deleted entries for this category
 * @returns {Array<{button: Object, highlight: boolean, timeStr: string|null}>}
 */
function computeButtonStates(group, categoryEntries) {
  const lastEntry = categoryEntries.length > 0 ? categoryEntries[categoryEntries.length - 1] : null;
  const mode = group.mode || 'event';

  return group.buttons.map((btn) => {
    let highlight = false;
    let timeStr = null;

    if (mode === 'toggle') {
      // Toggle mode: group has on/off states
      const onStates = group.onStates || [];
      const isOnButton = onStates.includes(btn.value);
      const currentIsOn = lastEntry && onStates.includes(lastEntry.value);

      if (lastEntry) {
        // Highlight the current state's button
        if (currentIsOn) {
          highlight = isOnButton && lastEntry.value === btn.value;
        } else {
          // Off state - highlight the button that was pressed (the current state)
          highlight = lastEntry.value === btn.value;
        }

        // Show time on highlighted button
        if (highlight) {
          timeStr = formatElapsedTime(new Date(lastEntry.ts).getTime());
        }
      } else {
        // No entries - no highlight
        highlight = false;
      }
    } else {
      // Event mode (default): simple event logging
      // Buttons with timer: true show elapsed time since last occurrence
      if (btn.timer) {
        const lastOfThisValue = [...categoryEntries].reverse().find((e) => e.value === btn.value);
        if (lastOfThisValue) {
          timeStr = formatElapsedTime(new Date(lastOfThisValue.ts).getTime());
          // Highlight if this was the last button pressed in the category
          highlight = lastEntry && lastEntry.value === btn.value;
        }
      }
    }

    return { button: btn, highlight, timeStr };
  });
}

/**
 * Update all button states from database
 * Called on load, after events, and periodically for timer updates
 */
async function updateButtonStates() {
  if (!db) await initDB();

  const today = new Date();
  const { start, end } = getDayBounds(today);
  const transaction = db.transaction(['entries'], 'readonly');
  const objectStore = transaction.objectStore('entries');
  const request = objectStore.index('timestamp').getAll(IDBKeyRange.bound(start, end));

  const allEntries = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  const activeEntries = allEntries.filter((e) => !e.deleted);

  buttonGroups.forEach((group) => {
    const categoryEntries = activeEntries.filter((e) => e.type === group.category);
    const states = computeButtonStates(group, categoryEntries);

    states.forEach(({ button: btn, highlight, timeStr }) => {
      const buttonEl = document.querySelector(`button[data-type="${group.category}"][data-value="${btn.value}"]`);
      if (buttonEl) {
        updateButtonDisplay(buttonEl, btn.label, timeStr, highlight);
      }
    });
  });
}

// ==================== Long Press ====================
let longPressTimer = null;
let longPressData = null;

function handleLongPressStart(type, value, btn, event) {
  event.preventDefault();
  longPressTimer = setTimeout(() => {
    longPressData = { type, value, btn };
    showTimePicker();
  }, 500);
}

function handleLongPressEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function showTimePicker() {
  const modal = document.getElementById('time-picker-modal');
  const input = document.getElementById('custom-time');

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  input.value = `${year}-${month}-${day}T${hours}:${minutes}`;

  modal.classList.add('show');
}

function hideTimePicker() {
  const modal = document.getElementById('time-picker-modal');
  modal.classList.remove('show');
  longPressData = null;
}

async function saveWithCustomTime() {
  const input = document.getElementById('custom-time');
  const customTime = new Date(input.value);

  if (!customTime || isNaN(customTime.getTime())) {
    alert('Please select a valid time');
    return;
  }

  const { type, value, btn } = longPressData;
  await save(type, value, btn, customTime.toISOString());
  hideTimePicker();
}

// ==================== Undo/Redo ====================
let actionStack = [];
let currentPosition = -1;
const MAX_STACK_SIZE = 20;

function addAction(action) {
  actionStack = actionStack.slice(0, currentPosition + 1);
  actionStack.push(action);
  currentPosition = actionStack.length - 1;

  if (actionStack.length > MAX_STACK_SIZE) {
    actionStack.shift();
    currentPosition--;
  }

  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  if (undoBtn) {
    undoBtn.disabled = false;
    undoBtn.textContent = 'Undo';
  }
  if (redoBtn) {
    redoBtn.disabled = currentPosition >= actionStack.length - 1;
    redoBtn.textContent = 'Redo';
  }
}

async function deleteEntry(id) {
  const entry = await toggleEntryDeleted(id, true);
  if (entry) {
    addAction({ type: 'toggle', entryId: id, wasDeleted: false });
  }
  return entry;
}

async function undeleteEntry(id) {
  const entry = await toggleEntryDeleted(id, false);
  if (entry) {
    addAction({ type: 'toggle', entryId: id, wasDeleted: true });
  }
  return entry;
}

async function addEntryWithUndo(type, value, ts) {
  await addEntry(type, value, ts);
  const allEntries = await loadEntriesByDate();
  const newEntry = allEntries[allEntries.length - 1];
  if (newEntry) {
    addAction({ type: 'add', entryId: newEntry.id });
  }
}

async function undo() {
  if (currentPosition >= 0 && currentPosition < actionStack.length) {
    const action = actionStack[currentPosition];
    currentPosition--;

    if (action.type === 'add') {
      await toggleEntryDeleted(action.entryId, true);
      updateTimestamp('Undid add');
    } else if (action.type === 'toggle') {
      await toggleEntryDeleted(action.entryId, action.wasDeleted);
      updateTimestamp(action.wasDeleted ? 'Undid undelete' : 'Undid delete');
    }
  } else {
    const allEntries = await loadEntriesByDate();
    const activeEntries = allEntries.filter((e) => !e.deleted);

    if (activeEntries.length > 0) {
      const mostRecentEntry = activeEntries.reduce((latest, entry) => {
        return new Date(entry.ts) > new Date(latest.ts) ? entry : latest;
      });

      await toggleEntryDeleted(mostRecentEntry.id, true);
      addAction({ type: 'toggle', entryId: mostRecentEntry.id, wasDeleted: false });
      currentPosition = actionStack.length;
      updateTimestamp(`Deleted most recent: ${mostRecentEntry.type} - ${mostRecentEntry.value}`);
    } else {
      updateTimestamp('No entries to undo');
      return;
    }
  }

  updateDailyReport();
  updateButtonStates();
  updateUndoRedoButtons();
}

async function redo() {
  if (currentPosition >= actionStack.length - 1) return;

  currentPosition++;
  const action = actionStack[currentPosition];

  if (action.type === 'add') {
    await toggleEntryDeleted(action.entryId, false);
    updateTimestamp('Redid add');
  } else if (action.type === 'toggle') {
    await toggleEntryDeleted(action.entryId, !action.wasDeleted);
    updateTimestamp(action.wasDeleted ? 'Redid undelete' : 'Redid delete');
  }

  updateDailyReport();
  updateButtonStates();
  updateUndoRedoButtons();
}

// ==================== Save & Notes ====================
function updateTimestamp(text) {
  const stamp = document.getElementById('laststamp');
  if (stamp) stamp.textContent = text;
}

async function save(type, value, btn, customTimestamp = null) {
  const ts = customTimestamp || nowIso();
  const eventTime = new Date(ts);

  if (btn) {
    btn.classList.add('fading');
    setTimeout(() => btn.classList.remove('fading'), 400);
  }

  await addEntryWithUndo(type, value, ts);

  updateTimestamp('Saved: ' + eventTime.toLocaleTimeString());
  updateDailyReport();
  updateButtonStates();
}

async function saveNote(e) {
  const v = e.target.value.trim();
  if (!v) return;
  await save('note', v);
  e.target.value = '';
}

// ==================== Export/Import ====================
async function downloadCSV() {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readonly');
  const objectStore = transaction.objectStore('entries');
  const request = objectStore.getAll();

  const entries = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  if (!entries || entries.length === 0) {
    alert('No data to export');
    return;
  }

  const hideDeleted = document.getElementById('hide-deleted-filter')?.checked ?? true;
  const exportEntries = hideDeleted ? entries.filter((e) => !e.deleted) : entries;

  if (exportEntries.length === 0) {
    alert('No data to export (all entries are deleted)');
    return;
  }

  const header = 'Timestamp,Type,Value';
  const rows = exportEntries.map((e) => {
    const date = new Date(e.ts);
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const mins = String(Math.abs(offset) % 60).padStart(2, '0');

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');

    const localTime = `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${hours}:${mins}`;
    return `"${localTime}","${e.type}","${e.value}"`;
  });
  const csv = [header, ...rows].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baby_log_' + new Date().toISOString().split('T')[0] + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importCSV() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const text = await file.text();
    const lines = text.trim().split('\n');

    let imported = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const match = line.match(/"([^"]*)","([^"]*)","([^"]*)"/);
      if (!match) {
        skipped++;
        continue;
      }

      const [, timestamp, type, value] = match;
      const ts = new Date(timestamp).toISOString();

      const exists = await checkEntryExists(ts, type, value);
      if (exists) {
        skipped++;
        continue;
      }

      await addEntry(type, value, ts);
      imported++;
    }

    alert(`Imported ${imported} entries, skipped ${skipped} duplicates`);
    updateDailyReport();
  };
  input.click();
}

async function checkEntryExists(ts, type, value) {
  if (!db) await initDB();
  const transaction = db.transaction(['entries'], 'readonly');
  const objectStore = transaction.objectStore('entries');
  const index = objectStore.index('ts');
  const request = index.getAll(IDBKeyRange.only(ts));

  const entries = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  return entries.some((e) => e.type === type && e.value === value);
}

async function downloadHourlyReport() {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readonly');
  const objectStore = transaction.objectStore('entries');
  const request = objectStore.getAll();

  const entries = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  if (!entries || entries.length === 0) {
    alert('No data to export');
    return;
  }

  const activeEntries = entries.filter((e) => !e.deleted);

  const entriesByDate = {};
  activeEntries.forEach((e) => {
    const date = new Date(e.ts);
    const dateKey = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear().toString().slice(-2)}`;
    if (!entriesByDate[dateKey]) entriesByDate[dateKey] = [];
    entriesByDate[dateKey].push(e);
  });

  const header = 'DATE\tTIME\tFood and Fluids Taken\tSleep\tSleep routine and how long it took to get to sleep once put down\tActivity\tWet Nappy\tDirty Nappy\tTOTAL SLEEP hh:mm\tComments';
  const rows = [];

  const sortedDates = Object.keys(entriesByDate).sort((a, b) => {
    const [da, ma, ya] = a.split('/').map(Number);
    const [db, mb, yb] = b.split('/').map(Number);
    return new Date(2000 + ya, ma - 1, da) - new Date(2000 + yb, mb - 1, db);
  });

  for (const dateKey of sortedDates) {
    const dayEntries = entriesByDate[dateKey];

    const hourlyData = {};
    for (let h = 0; h < 24; h++) {
      hourlyData[h] = {
        feed: [],
        sleep: [],
        sleepRoutine: [],
        activity: [],
        wet: false,
        dirty: false,
        comments: [],
      };
    }

    let sleepStart = null;
    let totalSleepMs = 0;
    const sleepByHour = {};

    dayEntries.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    dayEntries.forEach((e) => {
      const date = new Date(e.ts);
      const hour = date.getHours();

      if (e.type === 'feed') {
        hourlyData[hour].feed.push(e.value);
      } else if (e.type === 'sleep') {
        if (e.value === 'sleeping' || e.value === 'nap') {
          sleepStart = date;
          const sleepType = e.value === 'nap' ? 'nap' : 'sleep';
          hourlyData[hour].sleep.push(sleepType);
        } else if (e.value === 'awake' && sleepStart) {
          const duration = date - sleepStart;
          totalSleepMs += duration;

          let current = new Date(sleepStart);
          while (current < date) {
            const h = current.getHours();
            const nextHour = new Date(current);
            nextHour.setHours(h + 1, 0, 0, 0);
            const endOfPeriod = nextHour < date ? nextHour : date;
            const periodMs = endOfPeriod - current;
            sleepByHour[h] = (sleepByHour[h] || 0) + periodMs;
            current = nextHour;
          }
          sleepStart = null;
        } else if (e.value === 'grizzle') {
          hourlyData[hour].comments.push('grizzle');
        }
      } else if (e.type === 'nappy') {
        if (e.value === 'wet') hourlyData[hour].wet = true;
        if (e.value === 'dirty') hourlyData[hour].dirty = true;
      } else if (e.type === 'soothe' || e.type === '5s') {
        hourlyData[hour].sleepRoutine.push(e.value);
      } else if (e.type === 'note') {
        hourlyData[hour].comments.push(e.value);
      } else {
        hourlyData[hour].activity.push(`${e.type}: ${e.value}`);
      }
    });

    let isFirstRowOfDay = true;
    for (let h = 0; h < 24; h++) {
      const data = hourlyData[h];
      const hasData =
        data.feed.length > 0 ||
        data.sleep.length > 0 ||
        data.sleepRoutine.length > 0 ||
        data.activity.length > 0 ||
        data.wet ||
        data.dirty ||
        data.comments.length > 0 ||
        sleepByHour[h];

      if (!hasData) continue;

      const sleepMs = sleepByHour[h] || 0;
      const sleepMins = Math.round(sleepMs / 60000);
      const sleepHrs = Math.floor(sleepMins / 60);
      const sleepRemMins = sleepMins % 60;
      const sleepStr = sleepMs > 0 ? `${sleepHrs}:${sleepRemMins.toString().padStart(2, '0')}` : '0:00';

      const row = [
        isFirstRowOfDay ? dateKey : '',
        `${h.toString().padStart(2, '0')}:00`,
        data.feed.join(', '),
        data.sleep.join(', '),
        data.sleepRoutine.join(', '),
        data.activity.join(', '),
        data.wet ? 'yes' : '',
        data.dirty ? 'yes' : '',
        sleepStr,
        data.comments.join(', '),
      ];
      rows.push(row.join('\t'));
      isFirstRowOfDay = false;
    }
  }

  const tsv = [header, ...rows].join('\n');

  const blob = new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baby_hourly_report_' + new Date().toISOString().split('T')[0] + '.tsv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==================== Button Configuration ====================

// Default button groups - new spec format
const defaultButtonGroups = [
  {
    category: 'feed',
    mode: 'event',
    countDaily: 'bf',
    buttons: [
      { value: 'bf', label: 'Feed', emoji: '🤱', timer: true },
      { value: 'play', label: 'Play', emoji: '🎾' },
      { value: 'spew', label: 'Spew', emoji: '🤮' },
    ],
  },
  {
    category: 'sleep',
    mode: 'toggle',
    onStates: ['sleeping', 'nap'],
    buttons: [
      { value: 'sleeping', label: 'Sleeping', emoji: '' },
      { value: 'nap', label: 'Nap', emoji: '' },
      { value: 'awake', label: 'Awake', emoji: '' },
      { value: 'grizzle', label: 'Grizzle', emoji: '' },
    ],
  },
  {
    category: 'nappy',
    mode: 'event',
    countDaily: ['wet', 'dirty'],
    buttons: [
      { value: 'wet', label: 'Wet', emoji: '💧' },
      { value: 'dirty', label: 'Dirty', emoji: '💩' },
    ],
  },
  {
    category: 'soothe',
    mode: 'event',
    buttons: [
      { value: 'pram', label: 'Pram', emoji: '🎢' },
      { value: 'rocking', label: 'Rocking', emoji: '🪑' },
      { value: 'wearing', label: 'Wearing', emoji: '🤗' },
      { value: 'feed-to-sleep', label: 'Feed to Sleep', emoji: '🍼😴' },
    ],
  },
  {
    category: '5s',
    mode: 'event',
    buttons: [
      { value: 'swaddle', label: 'Swaddle', emoji: '🌯' },
      { value: 'side-lying', label: 'Side/Stomach', emoji: '🛏️' },
      { value: 'shush', label: 'Shush', emoji: '🤫' },
      { value: 'swing', label: 'Swing', emoji: '🎢' },
      { value: 'suck', label: 'Suck', emoji: '🍭' },
    ],
  },
];

/**
 * Migrate old config formats to new spec
 * - button.type -> group.category
 * - group.showTiming -> button.timer
 * - group.stateful -> group.mode='toggle' + group.onStates
 */
function migrateButtonGroups(groups) {
  return groups.map((group) => {
    const migrated = { ...group };

    // Migrate button.type to group.category
    if (migrated.category === undefined && migrated.buttons?.length > 0) {
      migrated.category = migrated.buttons[0].type || 'custom';
      migrated.buttons = migrated.buttons.map(({ type, ...rest }) => rest);
    }

    // Migrate showTiming to button.timer
    if (migrated.showTiming !== undefined) {
      const timingValues = Array.isArray(migrated.showTiming) ? migrated.showTiming : [migrated.showTiming];
      migrated.buttons = migrated.buttons.map(btn => ({
        ...btn,
        timer: timingValues.includes(btn.value) ? true : btn.timer
      }));
      delete migrated.showTiming;
    }

    // Migrate stateful to mode='toggle' + onStates
    if (migrated.stateful !== undefined) {
      migrated.mode = 'toggle';
      migrated.onStates = Array.isArray(migrated.stateful) ? migrated.stateful : [migrated.stateful];
      delete migrated.stateful;
    }

    // Default mode
    if (!migrated.mode) {
      migrated.mode = 'event';
    }

    return migrated;
  });
}

function loadButtonGroups() {
  const saved = localStorage.getItem('babytrack-buttons');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return migrateButtonGroups(parsed);
    } catch (e) {
      console.error('Failed to parse saved button config:', e);
    }
  }
  return JSON.parse(JSON.stringify(defaultButtonGroups));
}

let buttonGroups = loadButtonGroups();

// Emoji map for display
const emojiMap = { note: { '': '📝' } };

function rebuildEmojiMap() {
  for (const key in emojiMap) {
    if (key !== 'note') delete emojiMap[key];
  }
  buttonGroups.forEach((group) => {
    group.buttons.forEach((btn) => {
      if (!emojiMap[group.category]) emojiMap[group.category] = {};
      emojiMap[group.category][btn.value] = btn.emoji || '•';
    });
  });
}

// Initialize emoji map
buttonGroups.forEach((group) => {
  group.buttons.forEach((btn) => {
    if (!emojiMap[group.category]) emojiMap[group.category] = {};
    emojiMap[group.category][btn.value] = btn.emoji || '•';
  });
});

// ==================== Config Modal ====================
function openConfigModal() {
  const container = document.getElementById('config-groups');
  container.innerHTML = '';

  buttonGroups.forEach((group, groupIndex) => {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'config-group';
    groupDiv.dataset.groupIndex = groupIndex;

    groupDiv.innerHTML = `
      <div class="config-group-header">
        <label>Category: <input type="text" value="${group.category}" placeholder="category"
               onchange="updateGroupCategory(${groupIndex}, this.value)" style="width: 100px;"></label>
        <label>Mode:
          <select onchange="updateGroupOption(${groupIndex}, 'mode', this.value)">
            <option value="event" ${group.mode === 'event' ? 'selected' : ''}>Event</option>
            <option value="toggle" ${group.mode === 'toggle' ? 'selected' : ''}>Toggle</option>
          </select>
        </label>
        <button class="add-btn" onclick="addButtonToGroup(${groupIndex})">+ Add Button</button>
      </div>
      <div class="config-buttons" data-group="${groupIndex}"></div>
    `;

    const buttonsContainer = groupDiv.querySelector('.config-buttons');
    group.buttons.forEach((btn, btnIndex) => {
      buttonsContainer.appendChild(createButtonRow(groupIndex, btnIndex, btn));
    });

    container.appendChild(groupDiv);
  });

  const addGroupBtn = document.createElement('button');
  addGroupBtn.className = 'add-btn';
  addGroupBtn.style.width = '100%';
  addGroupBtn.textContent = '+ Add New Button Group';
  addGroupBtn.onclick = addNewGroup;
  container.appendChild(addGroupBtn);

  document.getElementById('config-modal').classList.add('show');
}

function createButtonRow(groupIndex, btnIndex, btn) {
  const row = document.createElement('div');
  row.className = 'config-button-row';
  row.innerHTML = `
    <input type="text" class="emoji-input" value="${btn.emoji || ''}" placeholder="😀" maxlength="4"
           onchange="updateConfigButton(${groupIndex}, ${btnIndex}, 'emoji', this.value)">
    <input type="text" value="${btn.label}" placeholder="Label"
           onchange="updateConfigButton(${groupIndex}, ${btnIndex}, 'label', this.value)">
    <label title="Show timer on this button">
      <input type="checkbox" ${btn.timer ? 'checked' : ''}
             onchange="updateConfigButton(${groupIndex}, ${btnIndex}, 'timer', this.checked)">
      ⏲️
    </label>
    <label title="Count in daily stats">
      <input type="checkbox" ${btn.counted ? 'checked' : ''}
             onchange="updateConfigButton(${groupIndex}, ${btnIndex}, 'counted', this.checked)">
      📊
    </label>
    <button class="remove-btn" onclick="removeButton(${groupIndex}, ${btnIndex})">×</button>
  `;
  return row;
}

function updateConfigButton(groupIndex, btnIndex, field, value) {
  if (field === 'label') {
    buttonGroups[groupIndex].buttons[btnIndex].value = value.toLowerCase().replace(/\s+/g, '-');
  }
  buttonGroups[groupIndex].buttons[btnIndex][field] = value;
}

function updateGroupCategory(groupIndex, value) {
  buttonGroups[groupIndex].category = value;
}

function updateGroupOption(groupIndex, option, value) {
  if (value === '') {
    delete buttonGroups[groupIndex][option];
  } else {
    buttonGroups[groupIndex][option] = value;
  }
}

function addButtonToGroup(groupIndex) {
  buttonGroups[groupIndex].buttons.push({
    value: 'new',
    label: 'New',
    emoji: '⭐',
  });
  openConfigModal();
}

function removeButton(groupIndex, btnIndex) {
  buttonGroups[groupIndex].buttons.splice(btnIndex, 1);
  if (buttonGroups[groupIndex].buttons.length === 0) {
    buttonGroups.splice(groupIndex, 1);
  }
  openConfigModal();
}

function addNewGroup() {
  buttonGroups.push({
    category: 'custom',
    mode: 'event',
    buttons: [{ value: 'new', label: 'New Button', emoji: '⭐' }],
  });
  openConfigModal();
}

function closeConfigModal() {
  buttonGroups = loadButtonGroups();
  document.getElementById('config-modal').classList.remove('show');
}

function saveConfig() {
  localStorage.setItem('babytrack-buttons', JSON.stringify(buttonGroups));
  localStorage.setItem('babytrack-config-updated', Date.now().toString());
  rebuildEmojiMap();
  renderButtons();
  document.getElementById('config-modal').classList.remove('show');
  updateDailyReport();
}

function resetConfig() {
  if (confirm("Reset all buttons to default? This will remove any custom buttons you've added.")) {
    localStorage.removeItem('babytrack-buttons');
    localStorage.removeItem('babytrack-config-updated');
    buttonGroups = loadButtonGroups();
    rebuildEmojiMap();
    renderButtons();
    document.getElementById('config-modal').classList.remove('show');
    updateDailyReport();
  }
}

// ==================== WebSocket Sync ====================
function initWebSocketSync() {
  if (typeof SyncClient === 'undefined') {
    console.log('[WS Sync] SyncClient not loaded, skipping WebSocket sync');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const familyId = params.get('family');

  if (!familyId) {
    console.log('[WS Sync] No family ID in URL, skipping WebSocket sync');
    return;
  }

  console.log('[WS Sync] Initializing WebSocket sync for family:', familyId);

  window.syncClient = new SyncClient({
    onConnect: () => {
      console.log('[WS Sync] Connected');
      updateWsSyncIndicator('connected');
    },
    onDisconnect: () => {
      console.log('[WS Sync] Disconnected');
      updateWsSyncIndicator('disconnected');
    },
    onInit: async (entries, config) => {
      console.log('[WS Sync] Received init with', entries.length, 'entries');
      await mergeRemoteEntries(entries);
      updateDailyReport();
    },
    onEntry: async (action, entry) => {
      console.log('[WS Sync] Received entry:', action, entry);
      await handleRemoteEntry(action, entry);
      updateDailyReport();
    },
    onPresence: (members) => {
      console.log('[WS Sync] Presence update:', members);
      updatePresenceIndicator(members);
    },
    onError: (err) => {
      console.error('[WS Sync] Error:', err);
    }
  });

  window.syncClient.connect();
}

function updateWsSyncIndicator(status) {
  if (status === 'connected') {
    console.log('[Sync] 🟢 Connected');
  } else {
    console.log('[Sync] 🔴 Offline');
  }
}

function updatePresenceIndicator(members) {
  if (members.length > 0) {
    console.log('[Presence] 👥 Online:', members.join(', '));
  }
}

async function mergeRemoteEntries(remoteEntries) {
  if (!db) await initDB();

  const transaction = db.transaction(['entries'], 'readwrite');
  const objectStore = transaction.objectStore('entries');

  for (const remote of remoteEntries) {
    const existingEntries = await new Promise((resolve, reject) => {
      const request = objectStore.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const existing = existingEntries.find(e => e.syncId === remote.id);

    if (existing) {
      const remoteUpdated = remote.updated_at || 0;
      const localUpdated = new Date(existing.updated).getTime();

      if (remoteUpdated > localUpdated) {
        existing.ts = new Date(remote.ts).toISOString();
        existing.type = remote.type;
        existing.value = remote.value;
        existing.deleted = remote.deleted;
        existing.updated = new Date(remoteUpdated).toISOString();
        objectStore.put(existing);
      }
    } else {
      const newEntry = {
        syncId: remote.id,
        ts: new Date(remote.ts).toISOString(),
        type: remote.type,
        value: remote.value,
        deleted: remote.deleted || false,
        updated: new Date(remote.updated_at || Date.now()).toISOString()
      };
      objectStore.add(newEntry);
    }
  }

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function handleRemoteEntry(action, entry) {
  if (!entry) return;

  if (action === 'delete') {
    if (!db) await initDB();
    const transaction = db.transaction(['entries'], 'readwrite');
    const objectStore = transaction.objectStore('entries');

    const allEntries = await new Promise((resolve, reject) => {
      const request = objectStore.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const existing = allEntries.find(e => e.syncId === entry.id);
    if (existing && !existing.deleted) {
      existing.deleted = true;
      existing.updated = new Date().toISOString();
      objectStore.put(existing);
    }
  } else {
    await mergeRemoteEntries([entry]);
  }
}

// ==================== Button Rendering ====================
function renderButtons() {
  const container = document.querySelector('.container');
  const headerRow = container.querySelector('.header-row');

  const existingCards = container.querySelectorAll('.card:not(#daily-report .card)');
  existingCards.forEach((card) => {
    if (!card.querySelector('#notes')) {
      card.remove();
    }
  });

  [...buttonGroups].reverse().forEach((group) => {
    const card = document.createElement('div');
    card.className = 'card';

    const row = document.createElement('div');
    row.className = 'row';

    group.buttons.forEach((btn) => {
      const button = document.createElement('button');
      button.className = 'action';
      button.dataset.type = group.category;
      button.dataset.value = btn.value;
      button.textContent = btn.label;
      button.onclick = function () {
        save(group.category, btn.value, this);
      };
      button.onpointerdown = function (e) {
        handleLongPressStart(group.category, btn.value, this, e);
      };
      button.onpointerup = handleLongPressEnd;
      button.onpointercancel = handleLongPressEnd;

      row.appendChild(button);
    });

    card.appendChild(row);
    headerRow.insertAdjacentElement('afterend', card);
  });
}

// ==================== Keyboard Handlers ====================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement?.id === 'notes') {
    saveNote({ target: document.activeElement });
  }
});

// ==================== Initialization ====================
// Initialize database on load
initDB();

// Initialize WebSocket sync (after short delay to ensure page is ready)
setTimeout(() => initWebSocketSync(), 100);

// Update button states every minute to keep elapsed times current
setInterval(() => {
  updateButtonStates();
}, 60000);

// ==================== Daily Report (stub - implemented in HTML) ====================
let currentReportDate = new Date();

function setReportDate(date) {
  if (typeof date === 'string') {
    const parts = date.split('-');
    currentReportDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  } else {
    currentReportDate = new Date(date);
  }
  updateDailyReport();
}

function changeReportDate(days) {
  currentReportDate.setDate(currentReportDate.getDate() + days);
  const year = currentReportDate.getFullYear();
  const month = String(currentReportDate.getMonth() + 1).padStart(2, '0');
  const day = String(currentReportDate.getDate()).padStart(2, '0');
  document.getElementById('report-date').value = `${year}-${month}-${day}`;
  updateDailyReport();
}

function goToToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  setReportDate(`${year}-${month}-${day}`);
}

// Placeholder - full implementation in HTML inline script due to D3 dependency
async function updateDailyReport() {
  // This will be overridden by the inline script in HTML
  // that has access to D3 and the DOM elements
}
