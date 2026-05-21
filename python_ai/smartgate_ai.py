import cv2
import easyocr
import requests
import time
import re
import os
import threading
import numpy as np
from ultralytics import YOLO

# --- CONFIGURATION ---
BASE_URL = os.getenv("BASE_URL", "http://localhost:3000")
LOG_URL = f"{BASE_URL}/log"
HEARTBEAT_URL = f"{BASE_URL}/api/heartbeat"

# Support laptop webcam (0) or mobile IP camera (http://192.168.x.x:8080/video)
CAMERA_SOURCE = os.getenv("CAMERA_SOURCE", "0")
if CAMERA_SOURCE.isdigit():
    CAMERA_SOURCE = int(CAMERA_SOURCE)

# Plate Validation Regex: AA 00 AA 0000
PLATE_REGEX = r'^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$'

# Cooldown and Validation
COOLDOWN_SECONDS = 60
VALIDATION_FRAMES = 3

# Initialize Models
print("Loading YOLOv8 and EasyOCR...")
model = YOLO('yolov8n.pt')
reader = easyocr.Reader(['en'], gpu=False) # Set gpu=True if available

# State
last_logged = {} # plate -> timestamp
plate_buffer = {} # track_id -> [plates]

def send_heartbeat():
    while True:
        try:
            requests.post(HEARTBEAT_URL, json={}, timeout=5)
        except:
            pass
        time.sleep(20)

# Start heartbeat thread
threading.Thread(target=send_heartbeat, daemon=True).start()

def is_valid_plate(plate):
    plate = plate.upper().replace(" ", "").replace("-", "")
    return bool(re.match(PLATE_REGEX, plate)), plate

def process_frame(frame):
    global last_logged, plate_buffer
    
    # Detect objects
    results = model(frame, verbose=False)
    
    for result in results:
        boxes = result.boxes
        for box in boxes:
            cls = int(box.cls[0])
            label = model.names[cls]
            
            # Detect car, bus, motorcycle (bike), truck
            if label in ['car', 'bus', 'motorcycle', 'truck']:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                
                # Crop vehicle for OCR
                vehicle_roi = frame[y1:y2, x1:x2]
                
                # Run OCR
                ocr_results = reader.readtext(vehicle_roi)
                
                for (bbox, text, prob) in ocr_results:
                    is_valid, clean_plate = is_valid_plate(text)
                    
                    if is_valid:
                        current_time = time.time()
                        
                        # Cooldown check
                        if clean_plate in last_logged:
                            if current_time - last_logged[clean_plate] < COOLDOWN_SECONDS:
                                continue
                        
                        # Multi-frame validation
                        if clean_plate not in plate_buffer:
                            plate_buffer[clean_plate] = []
                        
                        plate_buffer[clean_plate].append(current_time)
                        
                        # If we saw this plate 3 times recently
                        if len(plate_buffer[clean_plate]) >= VALIDATION_FRAMES:
                            print(f"✅ VALID PLATE DETECTED: {clean_plate}")
                            
                            # Send to backend
                            try:
                                payload = {
                                    "vehicle_number": clean_plate,
                                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                                }
                                requests.post(LOG_URL, json=payload, timeout=5)
                                last_logged[clean_plate] = current_time
                                plate_buffer[clean_plate] = [] # Clear buffer
                            except Exception as e:
                                print(f"❌ Failed to send to backend: {e}")

def main():
    print(f"Starting Camera: {CAMERA_SOURCE}")
    cap = cv2.VideoCapture(CAMERA_SOURCE)
    
    if not cap.isOpened():
        print("❌ Error: Could not open camera source.")
        return

    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        process_frame(frame)
        
        # Display (Optional, disable for headless)
        cv2.imshow('SmartGate AI', frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
            
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
