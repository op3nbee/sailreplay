import os
from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from datetime import datetime, timedelta
import secrets
import urllib.parse
import urllib.request
import json
import sqlite3
import gpxpy
from jose import jwt
from typing import Optional
from pathlib import Path
import html

app = FastAPI()

# CORS - allow frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Config
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "YOUR_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "YOUR_CLIENT_SECRET")
SECRET_KEY = os.getenv("SECRET_KEY", secrets.token_hex(32))
REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:5173/auth/callback")

# Database
DB_PATH = Path(__file__).parent / "data" / "sailreplay.db"
DB_PATH.parent.mkdir(exist_ok=True)

def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE,
            name TEXT,
            picture TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS practices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            date DATE NOT NULL,
            location TEXT,
            weather_conditions TEXT,
            wind_speed REAL,
            wind_direction REAL,
            temperature REAL,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        );
        
        CREATE TABLE IF NOT EXISTS boats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            practice_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            gpx_filename TEXT,
            color TEXT DEFAULT '#4285f4',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (practice_id) REFERENCES practices(id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS gpx_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            boat_id INTEGER NOT NULL,
            gpx_data TEXT NOT NULL,
            start_time TIMESTAMP,
            end_time TIMESTAMP,
            FOREIGN KEY (boat_id) REFERENCES boats(id) ON DELETE CASCADE
        );
    """)
    conn.commit()
    conn.close()

init_db()

# In-memory session store
sessions = {}

def create_token(data: dict) -> str:
    """Create JWT token"""
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=7)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm="HS256")

def decode_token(token: str) -> dict:
    """Decode JWT token"""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    except:
        return {}

def get_current_user(request: Request) -> Optional[dict]:
    """Get current user from session"""
    cookie = request.cookies.get("session")
    if not cookie:
        return None
    return decode_token(cookie)

def sanitize_input(text: str, max_length: int = 200) -> str:
    """Sanitize user input to prevent XSS"""
    if not text:
        return ""
    # Escape HTML characters
    text = html.escape(text)
    # Remove any null bytes
    text = text.replace('\x00', '')
    # Truncate to max length
    return text[:max_length].strip()

# ================== AUTH ==================

@app.get("/api/auth/login")
def login():
    state = secrets.token_hex(16)
    sessions[state] = {"created": datetime.utcnow()}
    
    params = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "consent"
    })
    return RedirectResponse(url=f"https://accounts.google.com/o/oauth2/v2/auth?{params}")

@app.get("/api/auth/callback")
def callback(code: str, state: str):
    if state not in sessions:
        return JSONResponse({"error": "Invalid state"}, status_code=400)
    del sessions[state]
    
    token_data = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": REDIRECT_URI
    }).encode()
    
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    
    with urllib.request.urlopen(req) as response:
        tokens = json.loads(response.read())
    
    access_token = tokens["access_token"]
    req = urllib.request.Request(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {access_token}"}
    )
    
    with urllib.request.urlopen(req) as response:
        user_info = json.loads(response.read())
    
    # Save user to DB
    conn = get_db()
    conn.execute("""
        INSERT OR REPLACE INTO users (id, email, name, picture)
        VALUES (?, ?, ?, ?)
    """, (user_info["id"], user_info["email"], user_info["name"], user_info["picture"]))
    conn.commit()
    conn.close()
    
    session_token = create_token({
        "sub": user_info["id"],
        "email": user_info["email"],
        "name": user_info["name"],
        "picture": user_info["picture"]
    })
    
    return RedirectResponse(
        url=f"/?token={session_token}",
        headers={"Set-Cookie": f"session={session_token}; HttpOnly; Path=/; Max-Age=604800"}
    )

@app.get("/api/auth/me")
def get_me(user: Optional[dict] = Depends(get_current_user)):
    if not user:
        return {"error": "Not authenticated"}
    return {
        "id": user.get("sub"),
        "email": user.get("email"),
        "name": user.get("name"),
        "picture": user.get("picture")
    }

@app.get("/api/auth/logout")
def logout():
    response = RedirectResponse(url="/")
    response.delete_cookie("session")
    return response

# ================== PRACTICES ==================

@app.get("/api/practices")
def list_practices(user: Optional[dict] = Depends(get_current_user)):
    """List all practices"""
    conn = get_db()
    practices = conn.execute("""
        SELECT p.*, u.name as creator_name, COUNT(b.id) as boat_count
        FROM practices p
        LEFT JOIN users u ON p.created_by = u.id
        LEFT JOIN boats b ON b.practice_id = p.id
        GROUP BY p.id
        ORDER BY p.date DESC
    """).fetchall()
    conn.close()
    return [dict(p) for p in practices]

@app.post("/api/practices")
def create_practice(
    name: str = Form(...),
    date: str = Form(...),
    location: str = Form(None),
    weather_conditions: str = Form(None),
    wind_speed: float = Form(None),
    wind_direction: float = Form(None),
    temperature: float = Form(None),
    gpx_files: list[UploadFile] = File(default=[]),
    boat_names: list[str] = Form(default=[]),
    boat_types: list[str] = Form(default=[]),
    user: Optional[dict] = Depends(get_current_user)
):
    """Create a new practice with GPX files - no auth required for local access"""
    # Skip auth check for local mode
    
    # Sanitize inputs
    name = sanitize_input(name, 200)
    location = sanitize_input(location, 200) if location else None
    
    if not name:
        return JSONResponse({"error": "Practice name is required"}, status_code=400)
    
    conn = get_db()
    
    # Create practice (user can be None in local mode)
    created_by = user["sub"] if user else "local"
    cursor = conn.execute("""
        INSERT INTO practices (name, date, location, weather_conditions, wind_speed, wind_direction, temperature, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (name, date, location, weather_conditions, wind_speed, wind_direction, temperature, created_by))
    practice_id = cursor.lastrowid
    
    # Create boats and save GPX
    GPX_DIR = DB_PATH.parent / "gpx"
    GPX_DIR.mkdir(exist_ok=True)
    
    # Default colors for boats
    colors = ['#4285f4', '#ea4335', '#34a853', '#fbbc05', '#9334e6', '#00acc1']
    
    for i, (gpx_file, boat_name, boat_type) in enumerate(zip(gpx_files, boat_names, boat_types)):
        if not gpx_file.filename:
            continue
        
        # Save GPX file
        gpx_content = gpx_file.file.read()
        
        # Validate file size (max 10MB per file)
        if len(gpx_content) > 10 * 1024 * 1024:
            conn.close()
            return JSONResponse({"error": f"GPX file '{gpx_file.filename}' exceeds 10MB limit"}, status_code=400)
        
        gpx_filename = f"{practice_id}_{i}_{gpx_file.filename}"
        gpx_path = GPX_DIR / gpx_filename
        gpx_path.write_bytes(gpx_content)
        
        # Parse GPX for metadata
        start_time = None
        end_time = None
        try:
            gpx = gpxpy.parse(gpx_content)
            if gpx.tracks and gpx.tracks[0].segments and gpx.tracks[0].segments[0].points:
                start_time = gpx.tracks[0].segments[0].points[0].time
                end_time = gpx.tracks[0].segments[0].points[-1].time
        except Exception as e:
            print(f"Error parsing GPX: {e}")
        
        # Create boat
        boat_name = boat_name or f"Boat {i+1}"
        boat_type = boat_type if boat_type else None
        color = colors[i % len(colors)]
        
        cursor = conn.execute("""
            INSERT INTO boats (practice_id, name, gpx_filename, color, boat_type)
            VALUES (?, ?, ?, ?, ?)
        """, (practice_id, boat_name, gpx_filename, color, boat_type))
        boat_id = cursor.lastrowid
        
        # Save GPX track data
        conn.execute("""
            INSERT INTO gpx_tracks (boat_id, gpx_data, start_time, end_time)
            VALUES (?, ?, ?, ?)
        """, (boat_id, gpx_content.decode('utf-8', errors='replace'), start_time, end_time))
    
    conn.commit()
    conn.close()
    
    return {"id": practice_id, "name": name, "date": date}

@app.get("/api/practices/{practice_id}")
def get_practice(practice_id: int, user: Optional[dict] = Depends(get_current_user)):
    """Get practice details with boats"""
    conn = get_db()
    practice = conn.execute("SELECT * FROM practices WHERE id = ?", (practice_id,)).fetchone()
    
    if not practice:
        conn.close()
        return JSONResponse({"error": "Practice not found"}, status_code=404)
    
    boats = conn.execute("""
        SELECT b.*, 
               (SELECT COUNT(*) FROM gpx_tracks WHERE boat_id = b.id) as has_track
        FROM boats b WHERE b.practice_id = ?
    """, (practice_id,)).fetchall()
    
    conn.close()
    
    return {
        **dict(practice),
        "boats": [dict(b) for b in boats]
    }

@app.get("/api/practices/{practice_id}/boats/{boat_id}/gpx")
def get_boat_gpx(practice_id: int, boat_id: int, user: Optional[dict] = Depends(get_current_user)):
    """Get GPX track for a boat"""
    conn = get_db()
    boat = conn.execute("SELECT * FROM boats WHERE id = ? AND practice_id = ?", (boat_id, practice_id)).fetchone()
    
    if not boat:
        conn.close()
        return JSONResponse({"error": "Boat not found"}, status_code=404)
    
    gpx_track = conn.execute("SELECT gpx_data FROM gpx_tracks WHERE boat_id = ?", (boat_id,)).fetchone()
    conn.close()
    
    if not gpx_track:
        return JSONResponse({"error": "No GPX data"}, status_code=404)
    
    return Response(gpx_track["gpx_data"], media_type="application/gpx+xml")

@app.patch("/api/practices/{practice_id}/boats/{boat_id}")
async def update_boat(practice_id: int, boat_id: int, request: Request, user: Optional[dict] = Depends(get_current_user)):
    """Update boat details (e.g., color)"""
    conn = get_db()
    boat = conn.execute("SELECT * FROM boats WHERE id = ? AND practice_id = ?", (boat_id, practice_id)).fetchone()
    
    if not boat:
        conn.close()
        return JSONResponse({"error": "Boat not found"}, status_code=404)
    
    # Parse request body
    try:
        data = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)
    
    # Update fields
    updates = []
    params = []
    
    if "color" in data:
        # Validate hex color
        if not data["color"].startswith("#") or len(data["color"]) not in [4, 7]:
            conn.close()
            return JSONResponse({"error": "Invalid color format"}, status_code=400)
        updates.append("color = ?")
        params.append(data["color"])
    
    if "name" in data:
        updates.append("name = ?")
        params.append(sanitize_input(data["name"], 100))
    
    if not updates:
        conn.close()
        return JSONResponse({"error": "No valid fields to update"}, status_code=400)
    
    params.extend([boat_id, practice_id])
    conn.execute(f"UPDATE boats SET {', '.join(updates)} WHERE id = ? AND practice_id = ?", params)
    conn.commit()
    
    # Return updated boat
    updated_boat = conn.execute("SELECT * FROM boats WHERE id = ?", (boat_id,)).fetchone()
    conn.close()
    
    return dict(updated_boat)

@app.delete("/api/practices/{practice_id}")
def delete_practice(practice_id: int, user: Optional[dict] = Depends(get_current_user)):
    """Delete a practice and all associated boats/GPX data"""
    conn = get_db()
    
    # Check if practice exists
    practice = conn.execute("SELECT * FROM practices WHERE id = ?", (practice_id,)).fetchone()
    if not practice:
        conn.close()
        return JSONResponse({"error": "Practice not found"}, status_code=404)
    
    # Get GPX filenames to delete from disk
    boats = conn.execute("SELECT gpx_filename FROM boats WHERE practice_id = ?", (practice_id,)).fetchall()
    
    # Delete GPX files from disk
    GPX_DIR = DB_PATH.parent / "gpx"
    for boat in boats:
        if boat["gpx_filename"]:
            gpx_path = GPX_DIR / boat["gpx_filename"]
            if gpx_path.exists():
                gpx_path.unlink()
    
    # Delete practice (cascades to boats and gpx_tracks)
    conn.execute("DELETE FROM practices WHERE id = ?", (practice_id,))
    conn.commit()
    conn.close()
    
    return {"message": "Practice deleted successfully"}

# ================== WEATHER ==================

@app.get("/api/weather")
def get_weather():
    """Get current weather from NOAA (DCA)"""
    # NOAA station ID for Reagan National Airport (DCA)
    # Using NOAA Climate Data Online API
    try:
        import requests
        # Try to get current conditions from NOAA
        # This uses the NOAA API to get current observations
        noaa_url = "https://api.weather.gov/stations/KDCA/observations/latest"
        
        # For simplicity, we'll return a message that manual entry is needed
        # In production, you'd want to cache this and handle API keys properly
        return {
            "station": "KDCA",
            "name": "Reagan National Airport",
            "temperature": None,
            "wind_speed": None,
            "wind_direction": None,
            "conditions": None,
            "note": "Weather API requires manual entry - use practice form"
        }
    except Exception as e:
        return {"error": f"Weather service unavailable: {str(e)}"}

# ================== HEALTH ==================

@app.get("/")
def root():
    return {"message": "SailReplay Georgetown API"}

@app.get("/api/health")
def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)