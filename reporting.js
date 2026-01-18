// BabyTrack Reporting & Visualization
// D3-based charts, stats, and event display

// ==================== Daily Report ====================

async function updateDailyReport() {
  const allEntries = await loadEntriesByDate(currentReportDate);

  // Filter out deleted entries for graphs/stats only
  const activeEntries = allEntries.filter((e) => !e.deleted);

  // Filter to only entries within the current day
  const entriesInDay = filterEntriesInDay(allEntries, currentReportDate);
  const activeEntriesInDay = filterEntriesInDay(activeEntries, currentReportDate);

  // Calculate statistics (uses activeEntries for cross-midnight sleep)
  const stats = calculateDailyStats(activeEntries);
  updateStatsDisplay(stats);

  // Display functions - graphs use active entries only, log uses all entries
  updateHourlyGrid(activeEntriesInDay);
  updateSleepAttempts(activeEntriesInDay);
  updateRecentEvents(entriesInDay); // Pass all entries including deleted

  // Timeline needs activeEntries to show cross-midnight sleep properly
  drawTimeline(activeEntries);
}

function calculateDailyStats(entries) {
  const sleepEvents = entries.filter((e) => e.type === 'sleep');

  // Get day boundaries for clipping sleep periods
  const { dayStart, dayEnd } = getDayBoundsAsDate(currentReportDate);

  // Build dynamic counts: auto-count all buttons in non-stateful groups
  const counts = {};
  buttonGroups.forEach((group) => {
    // Skip stateful groups - they track state, not events
    if (group.stateful) return;

    // Auto-count every button in non-stateful groups
    group.buttons.forEach((btn) => {
      const count = entries.filter((e) => {
        return e.type === group.category && e.value === btn.value && isEntryInDay(e, dayStart, dayEnd);
      }).length;
      
      // Only include in stats if count > 0
      if (count > 0) {
        counts[`${group.category}-${btn.value}`] = {
          count,
          label: btn.label,
          emoji: btn.emoji || '',
          category: group.category,
          value: btn.value,
        };
      }
    });
  });

  let totalSleepMinutes = 0;
  let currentSleepStart = null;

  // Check if day starts during a sleep period (sleep graph is special-cased)
  const eventsBeforeDay = sleepEvents.filter((e) => new Date(e.ts) < dayStart);
  if (eventsBeforeDay.length > 0) {
    const lastEventBeforeDay = eventsBeforeDay[eventsBeforeDay.length - 1];
    if (lastEventBeforeDay.value === 'sleeping' || lastEventBeforeDay.value === 'nap') {
      currentSleepStart = new Date(lastEventBeforeDay.ts);
    }
  }

  sleepEvents.forEach((event) => {
    if (event.value === 'sleeping' || event.value === 'nap') {
      currentSleepStart = new Date(event.ts);
    } else if (event.value === 'awake' && currentSleepStart) {
      const awakeTime = new Date(event.ts);

      // Clip sleep period to the current day's boundaries
      const clippedStart = currentSleepStart < dayStart ? dayStart : currentSleepStart;
      const clippedEnd = awakeTime > dayEnd ? dayEnd : awakeTime;

      // Only count if the clipped period is within the day
      if (clippedEnd > clippedStart) {
        const duration = (clippedEnd - clippedStart) / 1000 / 60;
        totalSleepMinutes += duration;
      }
      currentSleepStart = null;
    }
  });

  // Handle ongoing sleep that hasn't ended yet
  if (currentSleepStart) {
    const now = new Date();
    const reportDate = currentReportDate;
    const isToday = reportDate.toDateString() === now.toDateString();

    if (isToday) {
      // Clip to current time if viewing today
      const clippedStart = currentSleepStart < dayStart ? dayStart : currentSleepStart;
      const clippedEnd = now > dayEnd ? dayEnd : now;

      if (clippedEnd > clippedStart) {
        const duration = (clippedEnd - clippedStart) / 1000 / 60;
        totalSleepMinutes += duration;
      }
    } else {
      // For past days, assume sleep continued until end of day
      const clippedStart = currentSleepStart < dayStart ? dayStart : currentSleepStart;
      if (dayEnd > clippedStart) {
        const duration = (dayEnd - clippedStart) / 1000 / 60;
        totalSleepMinutes += duration;
      }
    }
  }

  const hours = Math.floor(totalSleepMinutes / 60);
  const minutes = Math.round(totalSleepMinutes % 60);

  return {
    totalSleep: `${hours}h ${minutes}m`,
    counts,
  };
}

function updateStatsDisplay(stats) {
  // Build stat data dynamically from config
  const statData = [
    {
      id: 'stat-sleep',
      value: stats.totalSleep,
      label: 'Total Sleep',
    },
  ];

  // Add auto-counted stats from non-stateful buttons
  Object.keys(stats.counts).forEach((key) => {
    const countInfo = stats.counts[key];
    statData.push({
      id: `stat-${key}`,
      value: countInfo.count,
      label: `${countInfo.emoji || ''} ${countInfo.label}`.trim(),
      isNumeric: true,
    });
  });

  // Ensure stats grid has correct elements
  const statsGrid = document.querySelector('.stats-grid');
  if (statsGrid) {
    // Create missing stat cards
    statData.forEach((stat) => {
      if (!document.getElementById(stat.id)) {
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
          <div class="label">${stat.label}</div>
          <div class="value" id="${stat.id}">0</div>
        `;
        statsGrid.appendChild(card);
      }
    });

    // Remove stat cards that are no longer in config
    const validIds = new Set(statData.map((s) => s.id));
    Array.from(statsGrid.querySelectorAll('.stat-card')).forEach((card) => {
      const valueEl = card.querySelector('.value');
      if (valueEl && !validIds.has(valueEl.id)) {
        card.remove();
      }
    });
  }

  statData.forEach((stat) => {
    const element = d3.select(`#${stat.id}`);

    if (stat.isNumeric) {
      // Animate numeric values
      const currentValue = parseInt(element.text()) || 0;
      const targetValue = stat.value;

      if (currentValue !== targetValue) {
        element
          .transition()
          .duration(500)
          .tween('text', function () {
            const i = d3.interpolateNumber(currentValue, targetValue);
            return function (t) {
              this.textContent = Math.round(i(t));
            };
          })
          .on('start', function () {
            d3.select(this).style('color', 'var(--primary)');
          })
          .on('end', function () {
            d3.select(this).transition().duration(200).style('color', '');
          });
      }
    } else {
      // Simple text update for non-numeric values
      if (element.text() !== stat.value) {
        element
          .transition()
          .duration(200)
          .style('opacity', 0.5)
          .transition()
          .duration(200)
          .style('opacity', 1)
          .on('start', function () {
            this.textContent = stat.value;
          });
      }
    }
  });
}

// ==================== Hourly Grid ====================

function updateHourlyGrid(entries) {
  for (let hour = 0; hour < 24; hour++) {
    const hourEntries = entries.filter((e) => {
      const entryHour = new Date(e.ts).getHours();
      return entryHour === hour;
    });

    const indicators = ['feed', 'sleep', 'wet', 'dirty'];
    indicators.forEach((type) => {
      const el = document.getElementById(`hour-${hour}-${type}`);
      if (el) {
        const hasEvent = hourEntries.some((e) => {
          if (type === 'feed') return e.type === 'feed' && e.value === 'bf';
          if (type === 'sleep') return e.type === 'sleep' && (e.value === 'sleeping' || e.value === 'nap');
          if (type === 'wet' || type === 'dirty') return e.type === 'nappy' && e.value === type;
          return e.type === type;
        });
        el.style.opacity = hasEvent ? '1' : '0.2';
      }
    });
  }
}

// ==================== Sleep Attempts ====================

function updateSleepAttempts(entries) {
  const sleepEvents = entries.filter((e) => e.type === 'sleep');

  const attempts = [];
  let currentAttempt = null;

  sleepEvents.forEach((event) => {
    if (event.value === 'sleeping' || event.value === 'nap') {
      if (currentAttempt) {
        attempts.push(currentAttempt);
      }
      currentAttempt = {
        start: new Date(event.ts),
        type: event.value,
        soothe: [],
      };
    } else if (event.value === 'awake' && currentAttempt) {
      currentAttempt.end = new Date(event.ts);
      const duration = (currentAttempt.end - currentAttempt.start) / 1000 / 60;
      currentAttempt.success = duration > 15; // More than 15 minutes = success
      attempts.push(currentAttempt);
      currentAttempt = null;
    }
  });

  if (currentAttempt) {
    currentAttempt.success = true; // Still sleeping
    attempts.push(currentAttempt);
  }

  const container = d3.select('#sleep-attempts-list');

  // Add unique IDs to attempts for D3 data binding
  const attemptsWithIds = attempts.map((attempt, index) => ({
    ...attempt,
    attemptId: `${attempt.start.getTime()}-${index}`,
  }));

  // D3 data binding for sleep attempts
  const attemptElements = container.selectAll('.attempt').data(attemptsWithIds, (d) => d.attemptId);

  // Remove exiting attempts
  attemptElements.exit().transition().duration(300).style('opacity', 0).style('height', '0px').style('padding', '0px').remove();

  // Add new attempts
  const enteringAttempts = attemptElements
    .enter()
    .append('div')
    .attr('class', (d) => `attempt ${d.success ? 'success' : 'fail'}`)
    .style('opacity', 0)
    .style('transform', 'scaleY(0.01)');

  // Update all attempts
  const allAttempts = enteringAttempts.merge(attemptElements);

  allAttempts
    .attr('class', (d) => `attempt ${d.success ? 'success' : 'fail'}`)
    .transition()
    .duration(300)
    .style('opacity', 1)
    .style('transform', '');

  allAttempts.html((d) => {
    const timeStr = d.start.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    let durationStr = '';
    if (d.end) {
      const mins = Math.round((d.end - d.start) / 1000 / 60);
      durationStr = `${mins}m`;
    } else {
      durationStr = 'ongoing';
    }

    return `
      <span>${timeStr} - ${d.type}</span>
      <span>${durationStr} ${d.success ? '✓' : '✗'}</span>
    `;
  });
}

// ==================== Recent Events ====================

let allDayEntries = []; // Store all entries for filtering

function updateRecentEvents(entries) {
  // Store entries globally for filtering
  allDayEntries = entries;
  console.log('[Report] updateRecentEvents called with', entries.length, 'entries');

  // Clear text and type filters but keep hide deleted checked by default
  d3.select('#event-filter').property('value', '');
  d3.select('#event-type-filter').property('value', '');

  // Apply current filter settings
  applyEventFilters();
}

function applyEventFilters() {
  const textFilter = d3.select('#event-filter').property('value').toLowerCase();
  const typeFilter = d3.select('#event-type-filter').property('value');
  const hideDeleted = d3.select('#hide-deleted-filter').property('checked');

  const filteredEntries = allDayEntries.filter((e) => {
    const matchesDeleted = !hideDeleted || !e.deleted;
    const matchesType = !typeFilter || e.type === typeFilter;
    const matchesText = !textFilter || e.type.toLowerCase().includes(textFilter) || e.value.toLowerCase().includes(textFilter);
    return matchesDeleted && matchesType && matchesText;
  });

  updateRecentEventsDisplay(filteredEntries);
}

function updateRecentEventsDisplay(entries) {
  const container = d3.select('#recent-events-list');
  if (!container.node()) {
    console.error('[Report] #recent-events-list container not found');
    return;
  }

  console.log('[Report] updateRecentEventsDisplay called with', entries.length, 'entries');

  // Show all events for the selected day in reverse chronological order
  const allEvents = [...entries].reverse();

  // D3 data binding using IndexedDB primary key
  const eventEntries = container.selectAll('.event-entry').data(allEvents, (d) => d.id);

  // Remove exiting events
  eventEntries
    .exit()
    .style('overflow', 'hidden')
    .transition()
    .duration(300)
    .style('opacity', 0)
    .style('max-height', '0px')
    .style('margin-top', '0px')
    .style('margin-bottom', '0px')
    .style('padding-top', '0px')
    .style('padding-bottom', '0px')
    .remove();

  // Add new events
  const enteringEvents = eventEntries
    .enter()
    .append('div')
    .attr('class', (d) => `event-entry${d.deleted ? ' deleted' : ''}`)
    .style('opacity', 0)
    .style('max-height', '0px')
    .style('overflow', 'hidden')
    .style('margin-top', '0px')
    .style('margin-bottom', '0px')
    .style('padding-top', '0px')
    .style('padding-bottom', '0px');

  // Update all events (both new and existing)
  const allEventEntries = enteringEvents.merge(eventEntries);

  allEventEntries
    .attr('class', (d) => `event-entry${d.deleted ? ' deleted' : ''}`)
    .transition()
    .duration(300)
    .style('opacity', 1)
    .style('max-height', '100px')
    .style('overflow', '')
    .style('margin-top', '')
    .style('margin-bottom', '')
    .style('padding-top', '')
    .style('padding-bottom', '');

  allEventEntries.html((d) => {
    const timeStr = new Date(d.ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const deletedLabel = d.deleted ? ' <small style="opacity: 0.6;">[deleted]</small>' : '';
    const actionBtn = d.deleted
      ? `<button class="action-btn undelete-btn" data-id="${d.id}">↶</button>`
      : `<button class="action-btn delete-btn" data-id="${d.id}">×</button>`;

    return `
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div>
          <span class="event-type">${d.type}</span><span class="event-value">: ${d.value}</span>${deletedLabel}
        </div>
        <div style="display: flex; align-items: center;">
          <span class="event-time">${timeStr}</span>${actionBtn}
        </div>
      </div>
    `;
  });

  // Helper function for entry actions
  const handleEntryAction = async (entry, action) => {
    const result = action === 'delete' ? await deleteEntry(entry.id) : await undeleteEntry(entry.id);
    if (result) {
      const actionText = action === 'delete' ? 'Deleted' : 'Restored';
      updateTimestamp(`${actionText}: ${result.type} - ${result.value}`);
      updateDailyReport();
      updateButtonStates();
    }
  };

  // Add event interactions
  allEventEntries
    .style('cursor', 'pointer')
    .on('click', function (event, d) {
      if (event.target.classList.contains('delete-btn')) {
        event.stopPropagation();
        handleEntryAction(d, 'delete');
      } else if (event.target.classList.contains('undelete-btn')) {
        event.stopPropagation();
        handleEntryAction(d, 'undelete');
      } else {
        showEventDetails(d, event);
      }
    })
    .on('dblclick', (event, d) => !d.deleted && handleEntryAction(d, 'delete'));
}

function showEventDetails(entry, event) {
  // Create or select tooltip div
  let tooltip = d3.select('body').select('.event-tooltip');
  if (tooltip.empty()) {
    tooltip = d3
      .select('body')
      .append('div')
      .attr('class', 'event-tooltip')
      .style('position', 'absolute')
      .style('background', 'var(--card)')
      .style('padding', '12px')
      .style('border-radius', '8px')
      .style('box-shadow', '0 4px 12px rgba(0,0,0,0.2)')
      .style('border', '1px solid var(--muted)')
      .style('font-size', '14px')
      .style('max-width', '250px')
      .style('z-index', '1001')
      .style('opacity', 0)
      .style('pointer-events', 'none');
  }

  const time = new Date(entry.ts);
  const fullTimeStr = time.toLocaleString();
  const elapsed = formatElapsedTime(time.getTime());

  tooltip.html(`
    <strong>Entry #${entry.id}</strong><br>
    <strong>Type:</strong> ${entry.type}<br>
    <strong>Value:</strong> ${entry.value}<br>
    <strong>Time:</strong> ${fullTimeStr}<br>
    <strong>Elapsed:</strong> ${elapsed}<br>
    <strong>Deleted:</strong> ${entry.deleted ? 'Yes' : 'No'}
  `);

  // Position tooltip near mouse
  const [mouseX, mouseY] = d3.pointer(event, d3.select('body').node());
  tooltip
    .style('left', mouseX + 10 + 'px')
    .style('top', mouseY - 10 + 'px')
    .transition()
    .duration(200)
    .style('opacity', 1);

  // Hide tooltip after 3 seconds
  setTimeout(() => {
    tooltip.transition().duration(300).style('opacity', 0);
  }, 3000);
}

// ==================== Timeline Chart ====================

function drawTimeline(entries) {
  const container = document.getElementById('timeline-chart');
  container.innerHTML = '';

  const width = container.clientWidth || 600;
  const height = 200;
  const margin = { top: 20, right: 20, bottom: 30, left: 40 };

  const svg = d3.select('#timeline-chart').append('svg').attr('width', width).attr('height', height);

  // Get day boundaries
  const { dayStart, dayEnd } = getDayBoundsAsDate(currentReportDate);

  // Filter to entries we care about for display
  const dayStart12HoursBefore = new Date(dayStart.getTime() - 12 * 60 * 60 * 1000);
  const dayEnd12HoursAfter = new Date(dayEnd.getTime() + 12 * 60 * 60 * 1000);

  const relevantEntries = entries.filter((e) => {
    const ts = new Date(e.ts);
    return ts >= dayStart12HoursBefore && ts <= dayEnd12HoursAfter;
  });

  if (relevantEntries.length === 0) {
    svg
      .append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .style('fill', getComputedStyle(document.documentElement).getPropertyValue('--text-muted'))
      .text('No data for this day');
    return;
  }

  // Prepare data for timeline - convert timestamps to hours relative to day start
  const sleepEvents = [];
  const eventData = []; // All non-sleep events

  relevantEntries.forEach((e) => {
    const date = new Date(e.ts);
    // Calculate hours relative to the start of the viewing day
    const hours = (date - dayStart) / (1000 * 60 * 60);

    if (e.type === 'sleep') {
      sleepEvents.push({
        time: hours,
        value: e.value,
        ts: date,
      });
    } else if (hours >= 0 && hours < 24) {
      // Look up emoji from the map
      let emoji = '•';
      if (emojiMap[e.type]) {
        emoji = emojiMap[e.type][e.value] || emojiMap[e.type][''] || '•';
      }
      eventData.push({
        time: hours,
        emoji: emoji,
        type: e.type,
        value: e.value,
      });
    }
  });

  // Create scales
  const x = d3
    .scaleLinear()
    .domain([0, 24])
    .range([margin.left, width - margin.right]);

  const y = d3
    .scaleLinear()
    .domain([0, 3])
    .range([height - margin.bottom, margin.top]);

  // Draw gridlines for every hour
  for (let hour = 0; hour <= 24; hour++) {
    svg
      .append('line')
      .attr('x1', x(hour))
      .attr('x2', x(hour))
      .attr('y1', margin.top)
      .attr('y2', height - margin.bottom)
      .attr('stroke', '#e0e0e0')
      .attr('stroke-width', 1)
      .attr('opacity', 0.5);
  }

  // Draw axes with fewer ticks (every 3 hours)
  svg
    .append('g')
    .attr('transform', `translate(0,${height - margin.bottom})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(8)
        .tickValues([0, 3, 6, 9, 12, 15, 18, 21, 24])
        .tickFormat((d) => d + 'h')
    );

  // Build continuous sleep state line data
  // States: 2.5 = awake, 1.5 = light sleep (<20 min), 0.5 = deep sleep (>20 min)
  const lineData = [];

  // Determine initial state based on previous day - add a mock event at time 0
  const eventsBeforeDay = sleepEvents.filter((e) => e.time < 0);
  if (eventsBeforeDay.length > 0) {
    const lastEventBeforeDay = eventsBeforeDay[eventsBeforeDay.length - 1];
    if (lastEventBeforeDay.value === 'sleeping' || lastEventBeforeDay.value === 'nap') {
      // Add a mock sleep event at midnight to continue the sleep
      sleepEvents.unshift({
        time: 0,
        value: lastEventBeforeDay.value,
        ts: dayStart,
      });
    } else {
      // Add a mock awake event at midnight
      sleepEvents.unshift({
        time: 0,
        value: 'awake',
        ts: dayStart,
      });
    }
  } else {
    // No previous events, assume awake at start
    sleepEvents.unshift({
      time: 0,
      value: 'awake',
      ts: dayStart,
    });
  }

  let currentState = 2.5; // awake
  let sleepStartTime = null;

  sleepEvents.forEach((event) => {
    const hour = Math.max(0, Math.min(24, event.time));

    if (event.value === 'sleeping' || event.value === 'nap') {
      // Starting to sleep
      sleepStartTime = event.time;
      currentState = 1.5; // light sleep
      if (hour >= 0 && hour <= 24) {
        lineData.push({ time: hour, state: currentState });
      }
    } else if (event.value === 'awake') {
      // Waking up - check duration
      if (sleepStartTime !== null) {
        const durationMinutes = (event.time - sleepStartTime) * 60;

        if (durationMinutes > 20) {
          // It was a deep sleep - add transition to deep sleep
          const deepSleepTime = Math.max(0, sleepStartTime + 20 / 60); // 20 minutes after sleep start
          if (deepSleepTime >= 0 && deepSleepTime <= 24) {
            lineData.push({
              time: deepSleepTime,
              state: 0.5,
            });
          }
        }
      }

      currentState = 2.5; // awake
      if (hour >= 0 && hour <= 24) {
        lineData.push({ time: hour, state: currentState });
      }
      sleepStartTime = null;
    }
  });

  // Determine end time and handle ongoing sleep
  const now = new Date();
  const isToday = currentReportDate.toDateString() === now.toDateString();
  const endTime = isToday ? now.getHours() + now.getMinutes() / 60 : 24;

  if (sleepStartTime !== null) {
    // Still sleeping at end of period
    const durationMinutes = (endTime - sleepStartTime) * 60;

    if (durationMinutes > 20) {
      const deepSleepTime = sleepStartTime + 20 / 60;
      if (deepSleepTime <= endTime && deepSleepTime >= 0) {
        lineData.push({ time: deepSleepTime, state: 0.5 });
      }
    }

    const finalState = durationMinutes > 20 ? 0.5 : 1.5;
    lineData.push({ time: endTime, state: finalState });
  } else {
    // End with current awake state
    lineData.push({ time: endTime, state: currentState });
  }

  // Sort by time
  lineData.sort((a, b) => a.time - b.time);

  // Create line generator
  const line = d3
    .line()
    .x((d) => x(d.time))
    .y((d) => y(d.state))
    .curve(d3.curveStepAfter);

  // Create area generator for shading above the line (but only up to awake level)
  const area = d3
    .area()
    .x((d) => x(d.time))
    .y0((d) => y(Math.min(d.state, 2.5)))
    .y1((d) => y(2.5))
    .curve(d3.curveStepAfter);

  // Draw shaded area under the sleep line
  svg.append('path').datum(lineData).attr('fill', '#2196f3').attr('fill-opacity', 0.1).attr('d', area);

  // Draw the sleep state line
  svg.append('path').datum(lineData).attr('fill', 'none').attr('stroke', '#2196f3').attr('stroke-width', 3).attr('d', line);

  // Draw events as emoji text with hash-based vertical spacing to avoid overlap
  // Simple hash function to spread emojis across vertical levels
  function hashStr(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  const emojiYLevels = 8; // Number of vertical levels for emoji distribution
  const emojiYRange = height - margin.top - margin.bottom - 30; // Leave space for labels

  eventData.forEach((d) => {
    // Hash based on time and type to distribute vertically
    const hash = hashStr(`${d.value}`);
    const levelOffset = (hash % emojiYLevels) / emojiYLevels;
    const yPos = margin.top + 10 + levelOffset * emojiYRange;

    svg
      .append('text')
      .attr('x', x(d.time))
      .attr('y', yPos)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .style('font-size', '16px')
      .style('cursor', 'pointer')
      .text(d.emoji)
      .append('title')
      .text(`${d.type}: ${d.value}`);
  });

  // Add Y-axis labels
  const axisColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted');

  svg
    .append('text')
    .attr('x', margin.left - 5)
    .attr('y', y(2.5))
    .attr('text-anchor', 'end')
    .attr('alignment-baseline', 'middle')
    .style('font-size', '11px')
    .style('fill', axisColor)
    .text('Awake');

  svg
    .append('text')
    .attr('x', margin.left - 5)
    .attr('y', y(1.5))
    .attr('text-anchor', 'end')
    .attr('alignment-baseline', 'middle')
    .style('font-size', '11px')
    .style('fill', axisColor)
    .text('Light');

  svg
    .append('text')
    .attr('x', margin.left - 5)
    .attr('y', y(0.5))
    .attr('text-anchor', 'end')
    .attr('alignment-baseline', 'middle')
    .style('font-size', '11px')
    .style('fill', axisColor)
    .text('Deep');
}

// ==================== Test Data Generator ====================

async function generateTestData() {
  const days = 7; // Generate a week of data
  const now = new Date();

  for (let day = days - 1; day >= 0; day--) {
    const baseDate = new Date(now);
    baseDate.setDate(baseDate.getDate() - day);
    baseDate.setHours(0, 0, 0, 0);

    // Generate sleep patterns (roughly 3-4 sleep cycles per day)
    const sleepCycles = 3 + Math.floor(Math.random() * 2);

    for (let cycle = 0; cycle < sleepCycles; cycle++) {
      // Sleep start time (spread throughout 24 hours)
      const sleepHour = Math.floor((24 / sleepCycles) * cycle + Math.random() * 2);
      const sleepMinute = Math.floor(Math.random() * 60);

      const sleepStart = new Date(baseDate);
      sleepStart.setHours(sleepHour, sleepMinute);

      // Sleep type: longer sleep at night, naps during day
      const sleepType = sleepHour >= 20 || sleepHour < 6 ? 'sleeping' : 'nap';
      await addEntry('sleep', sleepType, sleepStart.toISOString());

      // Sleep duration: 30min to 3 hours for naps, 2-5 hours for night sleep
      let durationMinutes;
      if (sleepType === 'nap') {
        durationMinutes = 30 + Math.random() * 150;
      } else {
        durationMinutes = 120 + Math.random() * 180;
      }

      const awakeTime = new Date(sleepStart);
      awakeTime.setMinutes(awakeTime.getMinutes() + durationMinutes);

      // Sometimes add soothe methods before sleep
      if (Math.random() > 0.5) {
        const sootheBefore = new Date(sleepStart);
        sootheBefore.setMinutes(sootheBefore.getMinutes() - 5);
        const sootheMethod = ['rocking', 'pram', 'wearing', 'feed-to-sleep'][Math.floor(Math.random() * 4)];
        await addEntry('soothe', sootheMethod, sootheBefore.toISOString());
      }

      await addEntry('sleep', 'awake', awakeTime.toISOString());
    }

    // Generate feeding events (every 2-4 hours, ~6-8 feeds per day)
    const feedCount = 6 + Math.floor(Math.random() * 3);

    for (let feed = 0; feed < feedCount; feed++) {
      const feedHour = Math.floor((24 / feedCount) * feed + Math.random() * 2);
      const feedMinute = Math.floor(Math.random() * 60);

      const feedTime = new Date(baseDate);
      feedTime.setHours(feedHour, feedMinute);

      await addEntry('feed', 'bf', feedTime.toISOString());

      // Sometimes spew after feeding
      if (Math.random() > 0.7) {
        const spewTime = new Date(feedTime);
        spewTime.setMinutes(spewTime.getMinutes() + 10 + Math.random() * 30);
        await addEntry('feed', 'spew', spewTime.toISOString());
      }

      // Occasional grizzle
      if (Math.random() > 0.8) {
        const grizzleTime = new Date(feedTime);
        grizzleTime.setMinutes(grizzleTime.getMinutes() - 5 - Math.random() * 10);
        await addEntry('feed', 'grizzle', grizzleTime.toISOString());
      }
    }

    // Generate Nappy changes (roughly 6-10 per day)
    const nappyCount = 6 + Math.floor(Math.random() * 5);

    for (let nappy = 0; nappy < nappyCount; nappy++) {
      const nappyHour = Math.floor((24 / nappyCount) * nappy + Math.random() * 2);
      const nappyMinute = Math.floor(Math.random() * 60);

      const nappyTime = new Date(baseDate);
      nappyTime.setHours(nappyHour, nappyMinute);

      // Most nappies are wet
      await addEntry('nappy', 'wet', nappyTime.toISOString());

      // About half are also dirty
      if (Math.random() > 0.5) {
        await addEntry('nappy', 'dirty', nappyTime.toISOString());
      }
    }

    // Occasional use of 5 S's techniques
    const fiveSCount = Math.floor(Math.random() * 4);
    for (let i = 0; i < fiveSCount; i++) {
      const fiveSHour = Math.floor(Math.random() * 24);
      const fiveSMinute = Math.floor(Math.random() * 60);

      const fiveSTime = new Date(baseDate);
      fiveSTime.setHours(fiveSHour, fiveSMinute);

      const technique = ['swaddle', 'side-lying', 'shush', 'swing', 'suck'][Math.floor(Math.random() * 5)];
      await addEntry('5s', technique, fiveSTime.toISOString());
    }

    // Add occasional notes
    if (Math.random() > 0.6) {
      const noteHour = Math.floor(Math.random() * 24);
      const noteMinute = Math.floor(Math.random() * 60);

      const noteTime = new Date(baseDate);
      noteTime.setHours(noteHour, noteMinute);

      const notes = [
        'Good day!',
        'A bit fussy today',
        'Slept well',
        'Cluster feeding',
        'Very alert and happy',
        'Seems gassy',
        'Long stretch of sleep!',
        'Growth spurts?',
      ];
      await addEntry('note', notes[Math.floor(Math.random() * notes.length)], noteTime.toISOString());
    }
  }

  console.log(`Generated ${days} days of test data`);
  await updateDailyReport();
}

// ==================== Hourly Grid Initialization ====================

function initHourlyGrid() {
  const hourlyGrid = document.getElementById('hourly-grid');
  if (!hourlyGrid) return;

  // Add empty cell for top-left corner
  const corner = document.createElement('div');
  hourlyGrid.appendChild(corner);

  // Add hour labels across the top
  for (let hour = 0; hour < 24; hour++) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.textContent = hour;
    hourlyGrid.appendChild(label);
  }

  // Add rows with labels
  const rows = [
    { label: 'Feed', type: 'feed' },
    { label: 'Sleep', type: 'sleep' },
    { label: 'Wet', type: 'wet' },
    { label: 'Dirty', type: 'dirty' },
  ];

  rows.forEach((row) => {
    // Add row label
    const rowLabel = document.createElement('div');
    rowLabel.className = 'row-label';
    rowLabel.textContent = row.label;
    hourlyGrid.appendChild(rowLabel);

    // Add indicators for each hour
    for (let hour = 0; hour < 24; hour++) {
      const indicator = document.createElement('div');
      indicator.className = `hour-indicator ${row.type}`;
      indicator.id = `hour-${hour}-${row.type}`;
      indicator.title = `${row.label} at ${hour}:00`;
      hourlyGrid.appendChild(indicator);
    }
  });
}

// ==================== Reporting Initialization ====================

function initReporting() {
  // Initialize date selector to today
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const reportDateEl = document.getElementById('report-date');
  if (reportDateEl) {
    reportDateEl.value = `${year}-${month}-${day}`;
  }

  // Build hourly grid
  initHourlyGrid();

  // Setup event filters
  d3.select('#event-filter').on('input', applyEventFilters);
  d3.select('#event-type-filter').on('change', applyEventFilters);
  d3.select('#hide-deleted-filter').on('change', applyEventFilters);
}
