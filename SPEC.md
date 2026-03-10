# SailReplay Georgetown — Project Specification

## 1. Overview

**Project Name:** SailReplay Georgetown  
**Type:** Web Application (Local-hosted + Cloudflare Tunnel)  
**Purpose:** Upload GPX boat tracks from practice, visualize as animated replays with interactive controls, share via browser with teammates.  
**Target Users:** Georgetown University Sailing Team (12-18 boats, ~20 sailors)

---

## 2. Requirements Summary

| Feature | Description |
|---------|-------------|
| **Authentication** | Google OAuth (Georgetown email restriction) |
| **GPX Upload** | Upload multiple GPX files per practice, assign boat names |
| **Position Extrapolation** | Calculate speed (knots) and heading (degrees) from lat/lon timestamps |
| **Weather Enrichment** | Pull wind direction/speed, water temperature from NOAA/weather APIs |
| **Wind Estimation** | Estimate wind direction from boat tacking angles (optional smart feature) |
| **Map Display** | OpenSeaMap / nautical charts, depth contours overlay |
| **Marks** | Draggable, createable, deletable — for start line, windward, offset marks |
| **Replay Player** | Variable speed (0.25x–4x), timeline scrubber, jump forward/back 30s, play/pause |
| **Multi-viewer** | Independent playback per client (each teammate watches own replay) |
| **Practice Management** | Group GPX files by practice date, assign practice name |
| **Hosting** | Mac Mini (local) + Cloudflare Tunnel (no domain required) |

---

## 3. Technical Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React + TypeScript + Vite |
| **Maps** | Leaflet + OpenSeaMap tiles + S-57 depth data |
| **State** | Zustand (lightweight, no Redux boilerplate) |
| **Backend** | Python FastAPI |
| **Database** | SQLite (stored locally on Mac Mini) |
| **Auth** | Google OAuth 2.0 (via `authlib`) |
| **Tunnel** | Cloudflare Tunnel (`cloudflared`) |
| **Container** | Docker (optional, or run native) |

---

## 4. Development Phases

### Phase 1: Foundation (Week 1)
- [ ] Project scaffolding (FastAPI + React)
- [ ] Google OAuth setup
- [ ] Basic GPX upload + parsing
- [ ] SQLite schema for practices, boats, tracks

### Phase 2: Map & Visualization (Week 2)
- [ ] Leaflet integration with nautical charts
- [ ] GPX track rendering on map (polylines)
- [ ] Speed/heading calculation from positions
- [ ] Depth overlay integration

### Phase 3: Replay Engine (Week 2–3)
- [ ] Playback controls (play/pause, speed, scrubber)
- [ ] Timeline jump controls
- [ ] Smooth animation loop
- [ ] Multiple boat rendering with color coding

### Phase 4: Marks & Annotations (Week 3)
- [ ] Mark CRUD (create, drag, delete)
- [ ] Persist marks per practice
- [ ] Start line tool (two-point drag)

### Phase 5: Weather Integration (Week 3–4)
- [ ] NOAA Marine Weather API integration
- [ ] Wind overlay on map
- [ ] Wind direction estimation from boat angles (stretch goal)

### Phase 6: Deployment (Week 4)
- [ ] Cloudflare Tunnel setup
- [ ] Local Mac Mini deployment
- [ ] Team onboarding

---

## 5. Atomic Task Breakdown

### Phase 1: Foundation

#### 1.1 Project Setup
- [ ] 1.1.1 Initialize FastAPI backend with project structure
- [ ] 1.1.2 Initialize React + Vite + TypeScript frontend
- [ ] 1.1.3 Set up folder structure (backend/, frontend/, data/)
- [ ] 1.1.4 Configure CORS between frontend:5173 and backend:8000
- [ ] 1.1.5 Verify empty shell runs (frontend builds, backend starts)

#### 1.2 Google Authentication
- [ ] 1.2.1 Create Google Cloud project, enable OAuth 2.0
- [ ] 1.2.2 Configure OAuth consent screen (Georgetown email restriction)
- [ ] 1.2.3 Add client ID/Secret to backend config
- [ ] 1.2.4 Implement `/auth/login` and `/auth/callback` endpoints
- [ ] 1.2.5 Create session/JWT token handling
- [ ] 1.2.6 Build login page with "Sign in with Google" button
- [ ] 1.2.7 Add auth guard — redirect unauthenticated users to login
- [ ] 1.2.8 Test login flow with Georgetown account

#### 1.3 Database Schema
- [ ] 1.3.1 Design SQLite schema (practices, boats, tracks, marks)
- [ ] 1.3.2 Create SQLAlchemy models
- [ ] 1.3.3 Implement database initialization script
- [ ] 1.3.4 Add CRUD endpoints for practices (create, list, delete)

#### 1.4 GPX Upload & Parsing
- [ ] 1.4.1 Build GPX file upload endpoint (multipart/form-data)
- [ ] 1.4.2 Parse GPX using `gpxpy` library
- [ ] 1.4.3 Extract: timestamp, lat, lon, elevation per trackpoint
- [ ] 1.4.4 Calculate speed (knots) and heading (degrees) between points
- [ ] 1.4.5 Store parsed track data in SQLite
- [ ] 1.4.6 Frontend: Practice detail page with file dropzone
- [ ] 1.4.7 Allow naming each uploaded GPX (boat name)
- [ ] 1.4.8 Test with sample GPX files

---

### Phase 2: Map & Visualization

#### 2.1 Map Integration
- [ ] 2.1.1 Install Leaflet + React-Leaflet
- [ ] 2.1.2 Configure OpenSeaMap tile layer (nautical)
- [ ] 2.1.3 Set map center to Potomac River / Reagan National area
- [ ] 2.1.4 Add map controls (zoom, fullscreen)

#### 2.2 Depth Overlay
- [ ] 2.2.1 Source NOAA S-57/S-63 chart data for Potomac River
- [ ] 2.2.2 Convert to tile format or use existing depth tile service
- [ ] 2.2.3 Add depth layer toggle (on/off)
- [ ] 2.2.4 Style depth contours (isobaths)

#### 2.3 Track Rendering
- [ ] 2.3.1 Fetch tracks for a practice from API
- [ ] 2.3.2 Render each boat as colored polyline on map
- [ ] 2.3.3 Color-code by boat name
- [ ] 2.3.4 Add boat label (name) at current position during replay

---

### Phase 3: Replay Engine

#### 3.1 Playback Core
- [ ] 3.1.1 Create `ReplayPlayer` React component
- [ ] 3.1.2 Implement `currentTime` state, tied to playback position
- [ ] 3.1.3 Build animation loop (`requestAnimationFrame`)
- [ ] 3.1.4 Interpolate position between GPX timestamps
- [ ] 3.1.5 Move boat markers based on `currentTime`

#### 3.2 Playback Controls
- [ ] 3.2.1 Play/Pause button
- [ ] 3.2.2 Speed selector: 0.25x, 0.5x, 1x, 2x, 4x
- [ ] 3.2.3 Timeline scrubber (range slider)
- [ ] 3.2.4 Jump back 30s / Jump forward 30s buttons
- [ ] 3.2.5 Display current time / total duration

#### 3.3 Multi-boat Sync
- [ ] 3.3.1 All boats advance together based on shared `currentTime`
- [ ] 3.3.2 Handle boats with different start/end times gracefully
- [ ] 3.3.3 Show "boat finished" state for boats that finished early

#### 3.4 Client-Side Independence
- [ ] 3.4.1 Ensure each browser client maintains own playback state
- [ ] 3.4.2 No server-side playback synchronization required
- [ ] 3.4.3 Test multiple tabs watching same practice independently

---

### Phase 4: Marks & Course Setup

#### 4.1 Mark CRUD
- [ ] 4.1.1 Add "Add Mark" button to map
- [ ] 4.1.2 Click map to place draggable marker
- [ ] 4.1.3 Drag to reposition
- [ ] 4.1.4 Right-click or button to delete
- [ ] 4.1.5 Persist marks to database per practice

#### 4.2 Start Line Tool
- [ ] 4.2.1 Add "Draw Start Line" mode
- [ ] 4.2.2 Click two points to define start line
- [ ] 4.2.3 Render as dashed line
- [ ] 4.2.4 Draggable endpoints

#### 4.3 Mark Types
- [ ] 4.3.1 Define mark types: Windward, Offset, Gate, Start, Finish
- [ ] 4.3.2 Color-code by mark type
- [ ] 4.3.3 Filter marks by type (show/hide)

---

### Phase 5: Weather Integration

#### 5.1 Weather API
- [ ] 5.1.1 Register for NOAA Marine Weather API (free)
- [ ] 5.1.2 Fetch wind direction, wind speed, water temperature
- [ ] 5.1.3 Cache weather data per practice (one fetch per practice date)
- [ ] 5.1.4 Store in database

#### 5.2 Wind Visualization
- [ ] 5.2.1 Add wind arrow overlay on map (one per practice)
- [ ] 5.2.2 Show wind speed label
- [ ] 5.2.3 Toggle wind overlay on/off

#### 5.3 Wind Estimation (Stretch Goal)
- [ ] 5.3.1 Algorithm: Detect tacks (heading changes > 30°)
- [ ] 5.3.2 Calculate apparent wind angles at each tack
- [ ] 5.3.3 Estimate true wind direction from multiple tacks
- [ ] 5.3.4 Compare estimated vs. NOAA data

---

### Phase 6: Deployment

#### 6.1 Local Deployment
- [ ] 6.1.1 Test backend runs on Mac Mini (python main.py)
- [ ] 6.1.2 Configure static file serving for React build
- [ ] 6.1.3 Test full flow: login → upload → replay

#### 6.2 Cloudflare Tunnel
- [ ] 6.2.1 Install `cloudflared` on Mac Mini
- [ ] 6.2.2 Authenticate with Cloudflare account
- [ ] 6.2.3 Create tunnel
- [ ] 6.2.4 Configure tunnel to proxy to localhost:8000
- [ ] 6.2.5 Get tunnel URL (e.g., `https://sail-replay-{random}.trycloudflare.com`)

#### 6.3 Team Onboarding
- [ ] 6.3.1 Share tunnel URL with team
- [ ] 6.3.2 Document usage instructions
- [ ] 6.3.3 Test with 2-3 team members simultaneously

---

## 6. API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login` | Redirect to Google OAuth |
| `GET` | `/auth/callback` | OAuth callback, set session |
| `GET` | `/auth/me` | Current user info |
| `POST` | `/practices` | Create new practice |
| `GET` | `/practices` | List all practices |
| `GET` | `/practices/{id}` | Practice detail with tracks |
| `DELETE` | `/practices/{id}` | Delete practice |
| `POST` | `/practices/{id}/tracks` | Upload GPX file |
| `GET` | `/practices/{id}/tracks` | Get all tracks for practice |
| `POST` | `/practices/{id}/marks` | Create mark |
| `GET` | `/practices/{id}/marks` | Get all marks |
| `PUT` | `/marks/{id}` | Update mark position |
| `DELETE` | `/marks/{id}` | Delete mark |

---

## 7. Database Schema

```sql
-- Users (from Google OAuth)
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    google_id TEXT UNIQUE,
    email TEXT,
    name TEXT,
    picture TEXT,
    created_at TIMESTAMP
);

-- Practices
CREATE TABLE practices (
    id INTEGER PRIMARY KEY,
    name TEXT,
    date DATE,
    weather_json TEXT,  -- wind, temp from NOAA
    wind_estimated_deg REAL,  -- estimated from tacks
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP
);

-- Boats/Tracks
CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    practice_id INTEGER REFERENCES practices(id),
    boat_name TEXT,
    gpx_filename TEXT,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    trackpoints_json TEXT  -- simplified: [{lat, lon, time, speed, heading}]
);

-- Marks
CREATE TABLE marks (
    id INTEGER PRIMARY KEY,
    practice_id INTEGER REFERENCES practices(id),
    mark_type TEXT,  -- windward, offset, gate, start, finish
    lat REAL,
    lon REAL,
    label TEXT,
    created_by INTEGER REFERENCES users(id)
);
```

---

## 8. File Structure

```
sail-replay/
├── backend/
│   ├── main.py              # FastAPI app
│   ├── auth.py              # Google OAuth handlers
│   ├── models.py            # SQLAlchemy models
│   ├── schemas.py          # Pydantic schemas
│   ├── database.py         # SQLite connection
│   ├── gpx_parser.py       # GPX parsing + speed/heading
│   ├── weather.py          # NOAA API client
│   ├── config.py           # Settings (env vars)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── PracticeList.tsx
│   │   │   ├── PracticeDetail.tsx
│   │   │   └── Replay.tsx
│   │   ├── components/
│   │   │   ├── Map.tsx
│   │   │   ├── TrackLayer.tsx
│   │   │   ├── ReplayPlayer.tsx
│   │   │   ├── MarkEditor.tsx
│   │   │   └── PlaybackControls.tsx
│   │   ├── stores/
│   │   │   └── replayStore.ts  # Zustand
│   │   ├── api/
│   │   │   └── client.ts
│   │   └── styles/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
└── README.md
```

---

## 9. Clarifications Answered

- [x] **GPX transfer:** Upload section on practice creation - select multiple files from folder
- [x] **Boat naming:** Auto-numbered (Boat 1, 2, 3...) but editable, mapped to GPX filenames
- [x] **Weather data:** NOAA station at DCA (Reagan National)
- [x] **Mac Mini:** M4, 24GB RAM, 512GB SSD — ample for local SQLite + app

---

## 10. Next Steps

1. **Confirm clarifications** (see Section 9)
2. **Initialize project** — Phase 1.1
3. **Set up Google OAuth** — Phase 1.2
4. **First upload test** — Phase 1.4 (with sample GPX)

---

*Specification created: 2026-03-09*
