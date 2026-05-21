import os
import time
import json
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import FastAPI, Request, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import socketio
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from gemini_service import detect_vehicle_and_plate

load_dotenv()

# --- Configuration ---
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/smartgate")
PORT = int(os.getenv("PORT", 3000))

# --- Socket.io Setup ---
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = socketio.ASGIApp(sio)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connect to MongoDB
client = AsyncIOMotorClient(MONGODB_URI)
db = client.get_database()

# Collections
faculty_collection = db.get_collection("faculty_vehicles")
bus_collection = db.get_collection("college_buses")
log_collection = db.get_collection("vehicle_logs")
heartbeat_collection = db.get_collection("heartbeats")
settings_collection = db.get_collection("settings")

# --- Models ---
class Faculty(BaseModel):
    name: str
    department: str
    vehicle_number: str

class Bus(BaseModel):
    bus_number: str
    driver_name: str
    vehicle_number: str

class VehicleLog(BaseModel):
    vehicle_number: str
    type: str
    entry_time: datetime = Field(default_factory=datetime.utcnow)
    timestamp: Optional[str] = None
    image: Optional[str] = None

class Heartbeat(BaseModel):
    last_heartbeat: datetime = Field(default_factory=datetime.utcnow)

# --- Endpoints ---

@app.get("/api/health")
async def health():
    return {"status": "ok", "db": "connected" if client else "disconnected"}

@app.post("/api/heartbeat")
async def heartbeat():
    try:
        now = datetime.utcnow()
        await heartbeat_collection.update_one({}, {"$set": {"last_heartbeat": now}}, upsert=True)
        await sio.emit('heartbeat', {'last_heartbeat': now.isoformat()})
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/status")
async def status():
    try:
        hb = await heartbeat_collection.find_one()
        if not hb:
            return {"status": "OFFLINE", "last_seen": None}
        
        last_heartbeat = hb.get("last_heartbeat")
        is_online = (datetime.utcnow() - last_heartbeat) < timedelta(seconds=30) if last_heartbeat else False
        
        return {
            "status": "ONLINE" if is_online else "OFFLINE",
            "last_seen": last_heartbeat.isoformat() if last_heartbeat else None
        }
    except Exception as e:
        return {"status": "OFFLINE", "error": str(e)}

@app.post("/api/gemini-ocr")
async def gemini_ocr(payload: dict = Body(...)):
    image = payload.get("image")
    if not image:
        raise HTTPException(status_code=400, detail="Image data required")
    try:
        result = await detect_vehicle_and_plate(image)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/log")
async def create_log(payload: dict = Body(...)):
    try:
        vehicle_number = payload.get("vehicle_number")
        if not vehicle_number:
            raise HTTPException(status_code=400, detail="Vehicle number required")
        
        plate = vehicle_number.upper().replace(" ", "")
        now = datetime.utcnow()

        # Cooldown check
        last_log = await log_collection.find_one({"vehicle_number": plate}, sort=[("entry_time", -1)])
        if last_log:
            diff = (now - last_log["entry_time"]).total_seconds()
            if diff < 60:
                return {"status": "skipped", "message": "Cooldown active (60s)"}

        # Categorize
        vehicle_type = "Visitor"
        faculty = await faculty_collection.find_one({"vehicle_number": plate})
        bus = await bus_collection.find_one({"vehicle_number": plate})
        
        if faculty:
            vehicle_type = "Faculty"
        elif bus:
            vehicle_type = "College Bus"

        log_data = {
            "vehicle_number": plate,
            "type": vehicle_type,
            "entry_time": now,
            "timestamp": payload.get("timestamp") or now.isoformat(),
            "image": payload.get("image")
        }
        
        result = await log_collection.insert_one(log_data)
        log_data["id"] = str(result.inserted_id)
        log_data["entry_time"] = log_data["entry_time"].isoformat()

        await sio.emit('log_new', log_data)
        return {"success": True, "log": log_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/logs")
async def get_logs():
    logs = await log_collection.find({}, sort=[("entry_time", -1)]).to_list(100)
    for log in logs:
        log["id"] = str(log.pop("_id"))
        if isinstance(log["entry_time"], datetime):
            log["entry_time"] = log["entry_time"].isoformat()
    return logs

@app.get("/api/inside-vehicles")
async def get_inside():
    logs = await log_collection.find({}, sort=[("entry_time", -1)]).to_list(10)
    for log in logs:
        log["id"] = str(log.pop("_id"))
        if isinstance(log["entry_time"], datetime):
            log["entry_time"] = log["entry_time"].isoformat()
    return logs

@app.get("/api/analytics")
async def get_analytics():
    total = await log_collection.count_documents({})
    faculty = await log_collection.count_documents({"type": "Faculty"})
    bus = await log_collection.count_documents({"type": "College Bus"})
    visitor = await log_collection.count_documents({"type": "Visitor"})
    
    return {
        "total_today": total,
        "faculty_count": faculty,
        "bus_count": bus,
        "visitor_count": visitor,
        "inside_now": total,
        "hourly_data": []
    }

@app.get("/api/faculty")
async def get_faculty():
    faculty = await faculty_collection.find().to_list(1000)
    for f in faculty:
        f["id"] = str(f.pop("_id"))
    return faculty

@app.post("/api/add-faculty")
async def add_faculty(f: Faculty):
    f.vehicle_number = f.vehicle_number.upper().replace(" ", "")
    result = await faculty_collection.insert_one(f.dict())
    return {"id": str(result.inserted_id), **f.dict()}

@app.get("/api/buses")
async def get_buses():
    buses = await bus_collection.find().to_list(1000)
    for b in buses:
        b["id"] = str(b.pop("_id"))
    return buses

@app.post("/api/add-bus")
async def add_bus(b: Bus):
    b.vehicle_number = b.vehicle_number.upper().replace(" ", "")
    result = await bus_collection.insert_one(b.dict())
    return {"id": str(result.inserted_id), **b.dict()}

@app.get("/api/settings")
async def get_settings():
    s = await settings_collection.find_one({})
    if not s:
        return {
            "ocr_confidence_threshold": 0.6,
            "validation_frames": 5,
            "cooldown_seconds": 60,
            "alert_on_unknown": True,
            "alert_on_frequent": True
        }
    s["id"] = str(s.pop("_id"))
    return s

@app.post("/api/settings")
async def update_settings(payload: dict = Body(...)):
    await settings_collection.update_one({}, {"$set": payload}, upsert=True)
    return payload

# Start server ping
@app.get("/api/ping")
async def ping():
    return {"pong": True}

# --- Serve Static Files ---
app.mount("/api", app) # Fallback for api prefix if needed, but we used it in decorators
app.mount("/", socket_app) # Use socketio app for root to handle WS

# Serve built frontend
dist_path = os.path.join(os.getcwd(), "dist")
if os.path.exists(dist_path):
    app.mount("/", StaticFiles(directory=dist_path, html=True), name="static")
    @app.exception_handler(404)
    async def not_found_handler(request, exc):
        return FileResponse(os.path.join(dist_path, "index.html"))

if __name__ == "__main__":
    import uvicorn
    # If running locally, you might want 3000. In prod, the platform sets PORT.
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True if os.getenv("DEV") else False)
