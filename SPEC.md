# Atomic Task Plan: MapReplay Fixes

## 1.1 Fix edit mode drag and drop marks
- Issue: Marks not draggable in edit mode
- Root cause: Need to verify draggable option is working and add proper event handling
- Fix: Ensure draggable is set correctly and test drag events

## 1.2 Remove weather display
- Issue: Weather API not working
- Fix: Remove weather fetch and display components from UI

## 1.3 Fix start/finish mark workflow
- Issue: Start/finish buttons drop both marks each time
- Fix: Allow independent start marks and finish marks, auto-draw line between them

## 1.4 Fix map rotation issues
- Issue 1a: 45° increments - use continuous rotation via slider/input
- Issue 1b: White bands - CSS rotate doesn't work with Leaflet tiles properly
- Issue 1c: Drag navigation broken - rotating via CSS breaks mouse coordinates
- Fix: Use Leaflet's native rotation or implement proper coordinate transformation

## Execution Order
1. First, fix the easy ones (1.2 weather removal, 1.3 start/finish)
2. Then fix edit mode drag (1.1)
3. Finally, tackle map rotation (1.4) - most complex
