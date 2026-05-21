import cv2
import requests
import base64
import time
import numpy as np
import re
import os
import threading
from ultralytics import YOLO
import socketio

# --- CONFIGURATION ---
# ⚠️ This is your actual public backend URL. Using 'localhost' will only work if the script runs on the same PC as the backend.
BACKEND_URL = "https://ais-pre-2cu6hqxp2jlyc4sfykx2lw-16053657483.asia-east1.run.app"
CAMERA_SOURCE = os.getenv("CAMERA_SOURCE", "0") 

if "localhost" in BACKEND_URL:
    print("\n" + "!"*60)
    print("⚠️  WARNING: You are using 'localhost'.")
    print("If your AI script is on a different PC than your backend,")
    print("you MUST set your BACKEND_URL to your public App URL.")
    print("!"*60 + "\n")

# Load YOLOv8/v10
print("Loading YOLO model...")
model = YOLO('yolov8n.pt') 

# State
last_logged = {} # plate -> timestamp
track_ocr_status = {} # track_id -> timestamp (to prevent flooding Gemini)
global_ocr_cooldown = 0
sio = socketio.Client()
session = requests.Session()
session.headers.update({
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json",
    "User-Agent": "SmartGate-AI-Detector/1.0"
})

def connect_socket():
    try:
        # websocket-client is required for optimal performance
        import websocket
    except ImportError:
        print("💡 TIP: Install 'websocket-client' for faster real-time updates: pip install websocket-client")
    
    try:
        sio.connect(BACKEND_URL, transports=['websocket', 'polling'])
        print(f"✅ Connected to Real-time Backend: {BACKEND_URL}")
    except Exception as e:
        print(f"⚠️ Socket.io connection failed: {e}")

@sio.on('heartbeat')
def on_heartbeat(data):
    pass

def send_heartbeat():
    while True:
        try:
            res = session.post(f"{BACKEND_URL}/api/heartbeat", timeout=5)
            if res.status_code == 200:
                # Optionally print occasionally
                if int(time.time()) % 60 < 15: # Every minute, print for 15s to avoid spam
                     print("💓 Heartbeat sent successfully.")
        except Exception as e:
            print(f"💔 Heartbeat failed: {e}")
        time.sleep(15)

threading.Thread(target=send_heartbeat, daemon=True).start()
threading.Thread(target=connect_socket, daemon=True).start()

def process_frame(frame):
    global last_logged, track_ocr_status, global_ocr_cooldown
    
    # Detect
    results = model.track(frame, persist=True, verbose=False)
    now = time.time()
    
    for r in results:
        boxes = r.boxes
        if boxes.id is not None:
            for box in boxes:
                track_id = int(box.id[0])
                cls = int(box.cls[0])
                label = model.names[cls]
                
                if label in ['car', 'bus', 'motorcycle', 'truck']:
                    # 🔋 GLOBAL COOLDOWN (Limit to 1 Gemini call every 5 seconds total)
                    if now - global_ocr_cooldown < 5:
                        continue
                        
                    # 🚦 PER-VEHICLE COOLDOWN (Limit to 1 check every 20 seconds for same ID)
                    if track_id in track_ocr_status and (now - track_ocr_status[track_id] < 20):
                        continue
                        
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    
                    # 📏 QUALITY CHECK: Only OCR if vehicle is "prominent" (covers > 5% of screen)
                    h, w = frame.shape[:2]
                    box_area = (x2 - x1) * (y2 - y1)
                    frame_area = h * w
                    if (box_area / frame_area) < 0.05:
                        continue

                    # Crop with padding
                    y1_p, y2_p = max(0, y1-10), min(h, y2+10)
                    x1_p, x2_p = max(0, x1-10), min(w, x2+10)
                    roi = frame[y1_p:y2_p, x1_p:x2_p]
                    
                    _, buffer = cv2.imencode('.jpg', roi)
                    img_b64 = base64.b64encode(buffer).decode('utf-8')
                    
                    # Log state before calling
                    track_ocr_status[track_id] = now
                    global_ocr_cooldown = now
                    
                    try:
                        print(f"🔍 Analyzing {label} (ID: {track_id})...")
                        res = session.post(f"{BACKEND_URL}/api/gemini-ocr", 
                                          json={"image": img_b64}, 
                                          timeout=40)
                        
                        if res.status_code == 200:
                            data = res.json()
                            if data.get('isValid'):
                                plate = data['plate']
                                
                                # Global cooldown per plate (60s)
                                if plate not in last_logged or (now - last_logged[plate] > 60):
                                    print(f"✨ SUCCESS: {plate} ({data['vehicle']}) | Conf: {data.get('confidence', 'N/A')}")
                                    
                                    # Log to Backend
                                    log_payload = {
                                        "vehicle_number": plate,
                                        "image": f"data:image/jpeg;base64,{img_b64}",
                                        "timestamp": datetime.utcnow().isoformat() + "Z"
                                    }
                                    session.post(f"{BACKEND_URL}/log", json=log_payload, timeout=10)
                                    last_logged[plate] = now
                                    # Mark as processed in tracker
                                    track_ocr_status[track_id] = now + 3600 # Wait an hour
                            else:
                                print(f"ℹ️ OCR result invalid: {data.get('plate', 'No plate')}")
                        elif res.status_code == 429:
                            print("🚨 QUOTA EXCEEDED: Slowing down requests further...")
                            global_ocr_cooldown = now + 30 # Extra 30s pause
                        elif res.status_code == 500 and "quota" in res.text.lower():
                            print("🚨 SERVER QUOTA ERROR: Waiting 30s...")
                            global_ocr_cooldown = now + 30
                        else:
                            print(f"⚠️ OCR Status {res.status_code}: {res.text[:100]}")
                            
                    except requests.exceptions.Timeout:
                        print("⏳ API Timeout: Gemini is taking longer than 40s...")
                    except Exception as e:
                        print(f"❌ Connection Error: {e}")

def main():
    try:
        source = int(CAMERA_SOURCE) if CAMERA_SOURCE.isdigit() else CAMERA_SOURCE
    except:
        source = CAMERA_SOURCE
        
    cap = cv2.VideoCapture(source)
    
    if not cap.isOpened():
        print(f"❌ Error: Could not open camera source: {source}")
        return

    print(f"🚀 AI Detector Running...")
    print(f"📡 Backend: {BACKEND_URL}")
    print(f"📷 Source: {source}")
    print("Press 'q' to quit.")
    
    while True:
        ret, frame = cap.read()
        if not ret: 
            print("⚠️ Frame drop detected. Reconnecting...")
            time.sleep(1)
            cap = cv2.VideoCapture(source)
            continue
        
        process_frame(frame)
        
        cv2.imshow('SmartGate AI - Monitor', frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
            
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    from datetime import datetime
    main()
