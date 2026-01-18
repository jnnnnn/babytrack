# Button Groups Specification

## Overview

Button groups are the core UI abstraction for logging baby events. Each group contains buttons that log events of the same category.

## Data Model

### Group Configuration

```typescript
interface ButtonGroup {
  category: string;           // Event type stored in DB (e.g., 'feed', 'sleep')
  stateful?: boolean;         // If true, group tracks current state (default: false)
  buttons: Button[];
}

interface Button {
  value: string;    // Value stored in DB
  label: string;    // Display text
  emoji?: string;   // Optional emoji
  timer?: boolean;  // Show elapsed time since last occurrence (event mode only)
}
```

### Display Modes

#### Event mode (`stateful: false`, default)
- Simple event logging
- Buttons with `timer: true` show elapsed time since last pressed
- **All button presses are automatically counted in daily stats**

#### Stateful mode (`stateful: true`)
- Group represents a state machine (e.g., sleeping/awake)
- Last pressed button is the current state
- Current state button is highlighted and shows elapsed time
- Stateful groups do NOT auto-count (they track state, not events)

### Timer Display

For event mode buttons with `timer: true`:
- Shows elapsed time since that button value was last logged
- Format: "2h 15m ago" or "45m ago"
- Timer updates every minute

For stateful mode:
- Active state button shows elapsed time (regardless of `timer` property)
- Time represents "how long in this state"

## Example Configurations

```javascript
// Feed group: event mode with timer on 'bf' button
// All buttons auto-counted in daily stats
{
  category: 'feed',
  buttons: [
    { value: 'bf', label: 'Feed', emoji: '🤱', timer: true },
    { value: 'play', label: 'Play', emoji: '🎾' },
    { value: 'spew', label: 'Spew', emoji: '🤮' },
  ],
}

// Sleep group: stateful - each button is a state
{
  category: 'sleep',
  stateful: true,
  buttons: [
    { value: 'sleeping', label: 'Sleeping' },
    { value: 'nap', label: 'Nap' },
    { value: 'awake', label: 'Awake' },
    { value: 'grizzle', label: 'Grizzle' },
  ],
}

// Nappy group: event mode, auto-counted
{
  category: 'nappy',
  buttons: [
    { value: 'wet', label: 'Wet', emoji: '💧' },
    { value: 'dirty', label: 'Dirty', emoji: '💩' },
  ],
}
```

## State Calculation

### For event mode groups:
```
For each button:
  if button has timer: true:
    lastEntry = most recent entry with this button's value
    if lastEntry exists:
      show elapsed time on button
  count all presses for daily stats
```

### For stateful groups:
```
lastEntry = most recent entry in this category
currentState = lastEntry?.value

For each button:
  highlighted = (button.value === currentState)
  if highlighted:
    show elapsed time since entering this state
```

## Migration

Old config format:
```javascript
{ mode: 'toggle', onStates: ['sleeping'], countDaily: 'bf' }
```

New config format:
```javascript
// mode: 'toggle' -> stateful: true
// countDaily removed - event mode buttons auto-count
// onStates removed - all buttons are states
```

Migration runs on load; old format still accepted but converted.

## Button Display States

| State | Background | Text Color | Shows Timer |
|-------|-----------|------------|-------------|
| Default | `--muted` | `--text` | If `timer: true` |
| Highlighted | `--primary` | `#fff` | Always |
| Fading (just pressed) | `--primary` | `#fff` | No |

## Implementation Notes

1. `updateButtonStates()` is called:
   - On page load
   - Every minute (for timer updates)
   - After any event is logged
   - After sync receives new data

2. Button state is purely derived from entries - no separate state storage

3. All entries for category are fetched, filtered for non-deleted, sorted by timestamp
