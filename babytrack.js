// BabyTrack Application JavaScript
// See docs/button-groups.md for button group specification

// ==================== Pure Functions (testable in Node.js) ====================

/**
 * Find the last entry in a list (pure function)
 * @param {Array} entries - Array of entries sorted by timestamp
 * @returns {Object|null} - The last entry or null
 */
function getLastEntry(entries) {
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * Find the last entry with a specific value (pure function)
 * @param {Array} entries - Array of entries sorted by timestamp
 * @param {string} value - Value to find
 * @returns {Object|null} - The last matching entry or null
 */
function findLastEntryByValue(entries, value) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].value === value) return entries[i];
  }
  return null;
}

/**
 * Format elapsed time from milliseconds (pure function)
 * @param {number} elapsedMs - Elapsed time in milliseconds
 * @returns {string} - Formatted string like "2h 15m ago"
 */
function formatElapsedTimeFromMs(elapsedMs) {
  const elapsed = Math.floor(elapsedMs / 1000 / 60);
  const hours = Math.floor(elapsed / 60);
  const mins = elapsed % 60;
  return hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
}

/**
 * Compute state for a single button in event mode (pure function)
 * @param {Object} btn - Button config
 * @param {Array} categoryEntries - Entries for this category
 * @param {number} now - Current timestamp in ms
 * @returns {{highlight: boolean, timeStr: string|null}}
 */
function computeEventButtonState(btn, categoryEntries, now) {
  const lastEntry = getLastEntry(categoryEntries);
  let highlight = false;
  let timeStr = null;

  if (btn.timer) {
    const lastOfThisValue = findLastEntryByValue(categoryEntries, btn.value);
    if (lastOfThisValue) {
      timeStr = formatElapsedTimeFromMs(now - new Date(lastOfThisValue.ts).getTime());
      highlight = lastEntry && lastEntry.value === btn.value;
    }
  }

  return { highlight, timeStr };
}

/**
 * Compute state for a single button in stateful mode (pure function)
 * @param {Object} btn - Button config
 * @param {Object|null} lastEntry - Most recent entry in category
 * @param {number} now - Current timestamp in ms
 * @returns {{highlight: boolean, timeStr: string|null}}
 */
function computeStatefulButtonState(btn, lastEntry, now) {
  if (!lastEntry) {
    return { highlight: false, timeStr: null };
  }

  const highlight = lastEntry.value === btn.value;
  const timeStr = highlight ? formatElapsedTimeFromMs(now - new Date(lastEntry.ts).getTime()) : null;

  return { highlight, timeStr };
}

/**
 * Compute button states for a group based on entries (pure function)
 * Implements the spec from docs/button-groups.md
 *
 * @param {Object} group - Button group config
 * @param {Array} categoryEntries - All non-deleted entries for this category
 * @param {number} now - Current timestamp in ms
 * @returns {Array<{button: Object, highlight: boolean, timeStr: string|null}>}
 */
function computeButtonStates(group, categoryEntries, now = Date.now()) {
  const isStateful = group.stateful === true;
  const lastEntry = getLastEntry(categoryEntries);

  return group.buttons.map((btn) => {
    const state = isStateful
      ? computeStatefulButtonState(btn, lastEntry, now)
      : computeEventButtonState(btn, categoryEntries, now);

    return { button: btn, ...state };
  });
}

/**
 * Migrate old config formats to new spec (pure function)
 * - mode: 'toggle' -> stateful: true
 * - countDaily removed (auto-count for non-stateful)
 * - onStates removed (all buttons are states)
 * @param {Array} groups - Button groups in old or new format
 * @returns {Array} - Migrated button groups
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

    // Migrate mode: 'toggle' to stateful: true
    if (migrated.mode === 'toggle') {
      migrated.stateful = true;
      delete migrated.mode;
      delete migrated.onStates;
    } else if (migrated.mode === 'event') {
      delete migrated.mode;
    }

    // Migrate old 'stateful' array to stateful: true
    if (Array.isArray(migrated.stateful)) {
      migrated.stateful = true;
    }

    // Remove countDaily (now auto-counted)
    delete migrated.countDaily;

    return migrated;
  });
}

// ==================== Tests (run with Node.js) ====================

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  function runTests() {
    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
      if (!condition) {
        console.error('FAIL:', message);
        failed++;
        return false;
      }
      passed++;
      return true;
    }

    function assertEqual(actual, expected, message) {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        console.error(`FAIL: ${message}\n  Expected: ${expectedStr}\n  Actual: ${actualStr}`);
        failed++;
        return false;
      }
      passed++;
      return true;
    }

    console.log('Running babytrack.js pure function tests...\n');

    // Test: getLastEntry
    (function testGetLastEntry() {
      console.log('Testing getLastEntry...');
      assertEqual(getLastEntry([]), null, 'empty array returns null');
      assertEqual(getLastEntry([{id: 1}]), {id: 1}, 'single element returned');
      assertEqual(getLastEntry([{id: 1}, {id: 2}, {id: 3}]), {id: 3}, 'last element returned');
    })();

    // Test: findLastEntryByValue
    (function testFindLastEntryByValue() {
      console.log('Testing findLastEntryByValue...');
      const entries = [
        {value: 'a', ts: '2024-01-01T01:00:00Z'},
        {value: 'b', ts: '2024-01-01T02:00:00Z'},
        {value: 'a', ts: '2024-01-01T03:00:00Z'},
        {value: 'c', ts: '2024-01-01T04:00:00Z'},
      ];
      assertEqual(findLastEntryByValue([], 'a'), null, 'empty array returns null');
      assertEqual(findLastEntryByValue(entries, 'x'), null, 'missing value returns null');
      assertEqual(findLastEntryByValue(entries, 'a'), entries[2], 'finds last matching entry');
      assertEqual(findLastEntryByValue(entries, 'c'), entries[3], 'finds single matching entry');
    })();

    // Test: formatElapsedTimeFromMs
    (function testFormatElapsedTimeFromMs() {
      console.log('Testing formatElapsedTimeFromMs...');
      assertEqual(formatElapsedTimeFromMs(0), '0m ago', '0 ms shows 0m ago');
      assertEqual(formatElapsedTimeFromMs(30 * 1000), '0m ago', '30s shows 0m ago');
      assertEqual(formatElapsedTimeFromMs(5 * 60 * 1000), '5m ago', '5 min');
      assertEqual(formatElapsedTimeFromMs(59 * 60 * 1000), '59m ago', '59 min');
      assertEqual(formatElapsedTimeFromMs(60 * 60 * 1000), '1h 0m ago', '60 min = 1h 0m');
      assertEqual(formatElapsedTimeFromMs(90 * 60 * 1000), '1h 30m ago', '90 min = 1h 30m');
      assertEqual(formatElapsedTimeFromMs((3 * 60 + 15) * 60 * 1000), '3h 15m ago', '3h 15m');
    })();

    // Test: computeEventButtonState
    (function testComputeEventButtonState() {
      console.log('Testing computeEventButtonState...');
      const now = new Date('2024-01-01T12:00:00Z').getTime();
      const entries = [
        {value: 'bf', ts: '2024-01-01T10:00:00Z'},
        {value: 'play', ts: '2024-01-01T11:00:00Z'},
      ];

      const btnNoTimer = {value: 'bf', label: 'Feed'};
      assertEqual(
        computeEventButtonState(btnNoTimer, entries, now),
        {highlight: false, timeStr: null},
        'button without timer has no highlight or time'
      );

      const btnWithTimer = {value: 'bf', label: 'Feed', timer: true};
      assertEqual(
        computeEventButtonState(btnWithTimer, entries, now),
        {highlight: false, timeStr: '2h 0m ago'},
        'timer button shows time, not highlighted if not last'
      );

      const btnPlayTimer = {value: 'play', label: 'Play', timer: true};
      assertEqual(
        computeEventButtonState(btnPlayTimer, entries, now),
        {highlight: true, timeStr: '1h 0m ago'},
        'timer button highlighted if last entry'
      );

      const btnNoEntry = {value: 'spew', label: 'Spew', timer: true};
      assertEqual(
        computeEventButtonState(btnNoEntry, entries, now),
        {highlight: false, timeStr: null},
        'timer button with no entries'
      );

      assertEqual(
        computeEventButtonState(btnWithTimer, [], now),
        {highlight: false, timeStr: null},
        'empty entries array'
      );
    })();

    // Test: computeStatefulButtonState
    (function testComputeStatefulButtonState() {
      console.log('Testing computeStatefulButtonState...');
      const now = new Date('2024-01-01T12:00:00Z').getTime();

      assertEqual(
        computeStatefulButtonState({value: 'sleeping', label: 'Sleeping'}, null, now),
        {highlight: false, timeStr: null},
        'null lastEntry - no highlight'
      );

      const lastEntry = {value: 'sleeping', ts: '2024-01-01T10:30:00Z'};
      assertEqual(
        computeStatefulButtonState({value: 'sleeping', label: 'Sleeping'}, lastEntry, now),
        {highlight: true, timeStr: '1h 30m ago'},
        'matching entry - highlighted with time'
      );

      assertEqual(
        computeStatefulButtonState({value: 'awake', label: 'Awake'}, lastEntry, now),
        {highlight: false, timeStr: null},
        'non-matching entry - not highlighted'
      );
    })();

    // Test: computeButtonStates
    (function testComputeButtonStates() {
      console.log('Testing computeButtonStates...');
      const now = new Date('2024-01-01T12:00:00Z').getTime();

      const statefulGroup = {
        category: 'sleep',
        stateful: true,
        buttons: [
          {value: 'sleeping', label: 'Sleeping'},
          {value: 'awake', label: 'Awake'},
        ],
      };
      const sleepEntries = [{value: 'sleeping', ts: '2024-01-01T11:00:00Z'}];
      const statefulResult = computeButtonStates(statefulGroup, sleepEntries, now);
      assertEqual(statefulResult.length, 2, 'stateful group returns 2 buttons');
      assert(statefulResult[0].highlight === true, 'sleeping button highlighted');
      assert(statefulResult[0].timeStr === '1h 0m ago', 'sleeping button shows time');
      assert(statefulResult[1].highlight === false, 'awake button not highlighted');
      assert(statefulResult[1].timeStr === null, 'awake button no time');

      const eventGroup = {
        category: 'feed',
        buttons: [
          {value: 'bf', label: 'Feed', timer: true},
          {value: 'play', label: 'Play'},
        ],
      };
      const feedEntries = [{value: 'bf', ts: '2024-01-01T11:30:00Z'}];
      const eventResult = computeButtonStates(eventGroup, feedEntries, now);
      assertEqual(eventResult.length, 2, 'event group returns 2 buttons');
      assert(eventResult[0].highlight === true, 'bf button highlighted (last + timer)');
      assert(eventResult[0].timeStr === '30m ago', 'bf button shows 30m');
      assert(eventResult[1].highlight === false, 'play button not highlighted');
      assert(eventResult[1].timeStr === null, 'play button no time (no timer flag)');

      const emptyResult = computeButtonStates(statefulGroup, [], now);
      assert(emptyResult[0].highlight === false, 'empty entries - no highlight');
      assert(emptyResult[0].timeStr === null, 'empty entries - no time');
    })();

    // Test: migrateButtonGroups
    (function testMigrateButtonGroups() {
      console.log('Testing migrateButtonGroups...');

      const oldToggle = [{
        category: 'sleep',
        mode: 'toggle',
        onStates: ['sleeping'],
        buttons: [{value: 'sleeping', label: 'Sleeping'}],
      }];
      const migratedToggle = migrateButtonGroups(oldToggle);
      assertEqual(migratedToggle[0].stateful, true, 'mode toggle -> stateful true');
      assertEqual(migratedToggle[0].mode, undefined, 'mode property removed');
      assertEqual(migratedToggle[0].onStates, undefined, 'onStates property removed');

      const oldEvent = [{
        category: 'feed',
        mode: 'event',
        countDaily: 'bf',
        buttons: [{value: 'bf', label: 'Feed'}],
      }];
      const migratedEvent = migrateButtonGroups(oldEvent);
      assertEqual(migratedEvent[0].mode, undefined, 'mode event removed');
      assertEqual(migratedEvent[0].countDaily, undefined, 'countDaily removed');

      const oldShowTiming = [{
        category: 'feed',
        showTiming: 'bf',
        buttons: [
          {value: 'bf', label: 'Feed'},
          {value: 'play', label: 'Play'},
        ],
      }];
      const migratedShowTiming = migrateButtonGroups(oldShowTiming);
      assertEqual(migratedShowTiming[0].buttons[0].timer, true, 'showTiming -> timer on matching button');
      assertEqual(migratedShowTiming[0].buttons[1].timer, undefined, 'non-matching button no timer');
      assertEqual(migratedShowTiming[0].showTiming, undefined, 'showTiming property removed');

      const newFormat = [{
        category: 'sleep',
        stateful: true,
        buttons: [{value: 'sleeping', label: 'Sleeping'}],
      }];
      const migratedNew = migrateButtonGroups(newFormat);
      assertEqual(migratedNew[0].stateful, true, 'new format preserved');
    })();

    console.log(`\nTests complete: ${passed} passed, ${failed} failed`);
    return failed === 0;
  }

  module.exports = {
    getLastEntry,
    findLastEntryByValue,
    formatElapsedTimeFromMs,
    computeEventButtonState,
    computeStatefulButtonState,
    computeButtonStates,
    migrateButtonGroups,
    runTests,
  };

  if (require.main === module) {
    const success = runTests();
    process.exit(success ? 0 : 1);
  }
} else {
  // Browser environment - run full application

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
  return formatElapsedTimeFromMs(Date.now() - timestampMs);
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
  const now = Date.now();

  buttonGroups.forEach((group) => {
    const categoryEntries = activeEntries.filter((e) => e.type === group.category);
    const states = computeButtonStates(group, categoryEntries, now);

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
    buttons: [
      { value: 'bf', label: 'Feed', emoji: '🤱', timer: true },
      { value: 'play', label: 'Play', emoji: '🎾' },
      { value: 'spew', label: 'Spew', emoji: '🤮' },
    ],
  },
  {
    category: 'sleep',
    stateful: true,
    buttons: [
      { value: 'sleeping', label: 'Sleeping', emoji: '' },
      { value: 'nap', label: 'Nap', emoji: '' },
      { value: 'awake', label: 'Awake', emoji: '' },
      { value: 'grizzle', label: 'Grizzle', emoji: '' },
    ],
  },
  {
    category: 'nappy',
    buttons: [
      { value: 'wet', label: 'Wet', emoji: '💧' },
      { value: 'dirty', label: 'Dirty', emoji: '💩' },
    ],
  },
  {
    category: 'soothe',
    buttons: [
      { value: 'pram', label: 'Pram', emoji: '🎢' },
      { value: 'rocking', label: 'Rocking', emoji: '🪑' },
      { value: 'wearing', label: 'Wearing', emoji: '🤗' },
      { value: 'feed-to-sleep', label: 'Feed to Sleep', emoji: '🍼😴' },
    ],
  },
  {
    category: '5s',
    buttons: [
      { value: 'swaddle', label: 'Swaddle', emoji: '🌯' },
      { value: 'side-lying', label: 'Side/Stomach', emoji: '🛏️' },
      { value: 'shush', label: 'Shush', emoji: '🤫' },
      { value: 'swing', label: 'Swing', emoji: '🎢' },
      { value: 'suck', label: 'Suck', emoji: '🍭' },
    ],
  },
];

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
        <label>Stateful:
          <input type="checkbox" ${group.stateful ? 'checked' : ''}
                 onchange="updateGroupOption(${groupIndex}, 'stateful', this.checked)">
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
  if (option === 'stateful') {
    if (value) {
      buttonGroups[groupIndex].stateful = true;
    } else {
      delete buttonGroups[groupIndex].stateful;
    }
  } else if (value === '' || value === false) {
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
// Wait for DOM to be fully ready (after all defer scripts have loaded)
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize database
  await initDB();
  
  // Initialize reporting after DB is ready (if reporting.js is loaded)
  if (typeof initReporting === 'function') {
    initReporting();
  }
  
  renderButtons();
  updateDailyReport();
  updateButtonStates();
  updateUndoRedoButtons();
  
  // Initialize WebSocket sync
  setTimeout(() => initWebSocketSync(), 100);
});

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

} // End of browser-only block
