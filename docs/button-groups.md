# Button Groups Specification

## Overview

Button groups are the core UI abstraction for logging baby events. Each group contains buttons that log events of the same category.

## Data Model

### Group Configuration

```typescript
interface ButtonGroup {
  category: string;           // Event type stored in DB (e.g., 'feed', 'sleep')
  mode?: 'event' | 'toggle';  // Display mode (default: 'event')
  onStates?: string[];        // For toggle mode: which values are "on"
  countDaily?: string | string[];  // Values to count in daily stats
  buttons: Button[];
}

interface Button {
  value: string;    // Value stored in DB
  label: string;    // Display text
  emoji?: string;   // Optional emoji
  timer?: boolean;  // Show elapsed time since last occurrence
}
```

### Display Modes

#### `event` mode (default)
- Simple event logging
- No highlighting
- Buttons with `timer: true` show elapsed time since that button was last pressed

#### `toggle` mode
- Group represents a state machine (e.g., sleeping/awake)
- Last pressed button determines current state
- If current state is in `onStates[]`: that button is highlighted
- If current state is NOT in `onStates[]`: first non-on button is highlighted
- Highlighted button shows elapsed time since state entered

### Timer Display

For buttons with `timer: true`:
- Shows elapsed time since that button value was last logged
- Format: "2h 15m" or "45m" or "Just now"
- Timer updates every minute

For toggle mode:
- Active state button shows elapsed time (regardless of `timer` property)
- Time represents "how long in this state"

## Example Configurations

```javascript
// Feed group: simple events with timer on 'bf' button
{
  category: 'feed',
  countDaily: 'bf',
  buttons: [
    { value: 'bf', label: 'Feed', emoji: '🤱', timer: true },
    { value: 'play', label: 'Play', emoji: '🎾' },
    { value: 'spew', label: 'Spew', emoji: '🤮' },
  ],
}

// Sleep group: toggle between sleeping/awake states
{
  category: 'sleep',
  mode: 'toggle',
  onStates: ['sleeping', 'nap'],
  buttons: [
    { value: 'sleeping', label: 'Sleeping' },
    { value: 'nap', label: 'Nap' },
    { value: 'awake', label: 'Awake' },
    { value: 'grizzle', label: 'Grizzle' },
  ],
}

// Nappy group: simple events with daily counts
{
  category: 'nappy',
  countDaily: ['wet', 'dirty'],
  buttons: [
    { value: 'wet', label: 'Wet', emoji: '💧' },
    { value: 'dirty', label: 'Dirty', emoji: '💩' },
  ],
}
```

## State Calculation

### For `event` mode groups:
```
For each button with timer: true:
  lastEntry = most recent entry with this button's value
  if lastEntry exists:
    show elapsed time on button
```

### For `toggle` mode groups:
```
lastEntry = most recent entry in this category
currentValue = lastEntry?.value
isOn = onStates.includes(currentValue)

For each button:
  isOnButton = onStates.includes(button.value)
  highlighted = (isOn && isOnButton) || (!isOn && button === firstOffButton)
  showTimer = highlighted
```

## Migration

Old config format:
```javascript
{ showTiming: 'bf', stateful: ['sleeping'] }
```

New config format:
```javascript
// showTiming -> timer: true on button
// stateful -> mode: 'toggle', onStates: [...]
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
