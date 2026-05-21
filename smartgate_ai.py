import cv2
import pytesseract
import requests
import base64
import time
import numpy as np
import re
import os
from ultralytics import YOLO
from collections import Counter

# --- LOCAL CONFIGURATION ---
# If you are on Windows and get "TesseractNotFoundError", 
# you can set the TESSERACT_PATH environment variable or edit below:
TESS_PATH = os.getenv("TESSERACT_PATH", r'C:\Program Files\Tesseract-OCR\tesseract.exe')
if os.path.exists(TESS_PATH):
    pytesseract.pytesseract.tesseract_cmd = TESS_PATH

# --- CONFIGURATION ---
# ⚠️ IMPORTANT: Update this to your actual App URL from the AI Studio preview
# Use the "Shared App URL" (starts with ais-pre-) for the AI module to bypass cookie checks.
BACKEND_URL = os.getenv("BACKEND_URL", "https://ais-pre-2cu6hqxp2jlyc4sfykx2lw-16053657483.asia-east1.run.app")

# 📱 CAMERA SETUP:
# To use a phone: Open "IP Webcam" app, click "Start Server", and set PHONE_IP (e.g., "192.168.1.5")
# To use a USB webcam: Leave PHONE_IP empty or set CAMERA_INDEX (e.g., "0")
PHONE_IP = os.getenv("PHONE_IP", "") 
CAMERA_INDEX = os.getenv("CAMERA_INDEX", "0")

# Determine Camera Source
if PHONE_IP:
    CAMERA_SOURCE = f"http://{PHONE_IP}:8080/video"
    print(f"📸 Using Phone Camera: {CAMERA_SOURCE}")
else:
    try:
        CAMERA_SOURCE = int(CAMERA_INDEX)
        print(f"📸 Using USB Webcam (Index: {CAMERA_SOURCE})")
    except ValueError:
        CAMERA_SOURCE = CAMERA_INDEX
        print(f"📸 Using Custom Camera Source: {CAMERA_SOURCE}")

CONFIDENCE_THRESHOLD = 0.35 # Slightly higher for better quality
COOLDOWN_SECONDS = 30 
VALIDATION_FRAMES = 3 # Require 3 consistent OCR hits for local confirmation
FRAME_SKIP = 2 # Skip every other frame to reduce CPU lag
RESIZE_WIDTH = 800 # Reduced for faster detection, OCR still uses high-res
FAST_VALIDATE_PROB = 0.50 
HEADLESS = False 
# ---------------------

# Indian Number Plate Regex (Standard formats: AA 00 AA 0000)
# More flexible to handle variations: AP 09 AB 1234, KA 01 A 1234, MH 12 AB 567
PLATE_REGEX = r'^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$'

# Initialize Models
# Using YOLOv10 for real-time performance (NMS-free)
# To use YOLOv10, ensure you have the ultralytics package updated
print("Loading YOLOv10 and Tesseract...")
try:
    # Attempt to load YOLOv10n
    model = YOLO('yolov10n.pt') 
    print("✅ YOLOv10 Loaded Successfully")
except Exception as e:
    print(f"❌ YOLOv10 not found, falling back to YOLOv8: {e}")
    model = YOLO('yolov8n.pt')

# OCR Engines
# Tesseract configuration for license plates
# --psm 7: Treat the image as a single text line
# -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789: Whitelist for plates
TESSERACT_CONFIG = '--psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

# State
vehicle_buffers = {} # track_id -> [plates]
processed_ids = set() # track_ids already logged in current session
last_logged_plates = {} # plate -> timestamp to prevent duplicates
gemini_attempts = {} # track_id -> last_attempt_time
offline_queue = [] # Logs that failed to sync
last_settings_fetch = 0
last_command_check = 0
last_heartbeat = 0
last_cleanup = 0
frame_count = 0

# --- HELPERS ---

def safe_request(method, url, **kwargs):
    """Wrapper for requests with minimal blocking."""
    try:
        # Use a very short timeout for background tasks
        timeout = kwargs.get('timeout', 2)
        headers = kwargs.get('headers', {})
        if 'User-Agent' not in headers:
            headers['User-Agent'] = 'SmartGateAI-Module/1.0'
        kwargs['headers'] = headers
        response = requests.request(method, url, **kwargs)
        
        # If it's HTML, the server is likely still starting or cookie check is active
        content_type = response.headers.get('Content-Type', '')
        if 'text/html' in content_type.lower():
            if "Cookie check" in response.text or "Checking your browser" in response.text:
                print("\n" + "!"*60)
                print("❌ ERROR: AI Studio Security Check (Cookie Check) detected.")
                print("!"*60)
                print("\n💡 HOW TO FIX THIS:")
                print("1. Go to your AI Studio browser tab.")
                print("2. Click the 'Share' button in the top-right corner.")
                print("3. Ensure sharing is ENABLED (you don't need to send the link to anyone).")
                print("4. This 'activates' the public URL so this script can connect.")
                print(f"\n🔗 TARGET URL: {url}")
                print("-" * 60 + "\n")
            return None # Silently fail and let the loop continue
            
        return response
    except Exception as e:
        # For connectivity check, we might want to see the error
        if "/api/health" in url:
            print(f"DEBUG: Request failed to {url}: {e}")
        return None

def calculate_brightness(img):
    """Calculate average brightness of the frame."""
    if img is None: return 0
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    _, _, v = cv2.split(hsv)
    return np.mean(v)

def preprocess_image(img):
    """Apply grayscale, contrast enhancement, and thresholding for better OCR."""
    if img is None or img.size == 0: return None
    
    # Resize ROI to a standard height for OCR consistency
    h, w = img.shape[:2]
    new_h = 100
    new_w = int(w * (new_h / h))
    img = cv2.resize(img, (new_w, new_h))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Increase contrast
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8))
    contrast = clahe.apply(gray)
    
    # Bilateral filter to remove noise while keeping edges sharp
    denoised = cv2.bilateralFilter(contrast, 9, 75, 75)
    
    # Adaptive thresholding for varying light
    thresh = cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)
    
    return thresh

def is_valid_indian_plate(plate):
    """Validate plate against Indian format regex."""
    return bool(re.match(PLATE_REGEX, plate))

def process_offline_queue():
    global offline_queue
    if not offline_queue: return
    
    print(f"Attempting to sync {len(offline_queue)} offline logs...")
    remaining = []
    for log in offline_queue:
        try:
            response = safe_request("POST", f"{BACKEND_URL}/log", json=log, timeout=5)
            if response and response.status_code == 200:
                # Successfully synced
                pass
            else:
                remaining.append(log)
        except Exception:
            remaining.append(log)
    
    offline_queue = remaining
    if not offline_queue:
        log_debug("Offline queue synced successfully", "INFO")

def send_heartbeat():
    global last_heartbeat
    try:
        if time.time() - last_heartbeat < 10:
            return
        res = safe_request("POST", f"{BACKEND_URL}/api/heartbeat", timeout=2)
        if res and res.status_code == 200:
            last_heartbeat = time.time()
            if frame_count % 100 == 0:
                print("✅ Heartbeat synced with backend.")
            process_offline_queue()
        elif res and res.status_code == 503:
            if frame_count % 100 == 0:
                print("⚠️ Heartbeat failed: Database is offline (Status: 503).")
        else:
            status = res.status_code if res else "No Response"
            if frame_count % 100 == 0: # Don't spam
                print(f"⚠️ Heartbeat failed (Status: {status}). Backend might be offline.")
    except Exception as e:
        if frame_count % 100 == 0:
            print(f"❌ Heartbeat error: {e}")

def fetch_settings():
    global CONFIDENCE_THRESHOLD, COOLDOWN_SECONDS, VALIDATION_FRAMES, last_settings_fetch
    try:
        if time.time() - last_settings_fetch < 60:
            return
        response = safe_request("GET", f"{BACKEND_URL}/api/settings", timeout=3)
        if response and response.status_code == 200:
            settings = response.json()
            CONFIDENCE_THRESHOLD = settings.get('ocr_confidence_threshold', 0.6)
            COOLDOWN_SECONDS = settings.get('cooldown_seconds', 60)
            VALIDATION_FRAMES = settings.get('validation_frames', 5)
            last_settings_fetch = time.time()
    except Exception:
        pass

def check_commands(frame):
    global last_command_check, BACKEND_URL
    try:
        if time.time() - last_command_check < 2:
            return
        last_command_check = time.time()
        response = safe_request("GET", f"{BACKEND_URL}/api/commands/pending", timeout=2)
        if response and response.status_code == 200:
            cmd = response.json()
            if not cmd: return
            
            if cmd.get('type') == 'CAPTURE_SNAPSHOT':
                _, buffer = cv2.imencode('.jpg', frame)
                img_b64 = base64.b64encode(buffer).decode('utf-8')
                safe_request("POST", f"{BACKEND_URL}/api/commands/{cmd['id']}/respond", 
                              json={"image": f"data:image/jpeg;base64,{img_b64}"}, 
                              timeout=5)
                log_debug("Manual snapshot captured and sent", "INFO")
            
            elif cmd.get('type') == 'STRESS_TEST':
                test_type = cmd.get('payload', {}).get('test_type')
                log_debug(f"Starting Stress Test: {test_type}", "WARNING")
                
                if test_type == 'NETWORK_FAILURE':
                    # Simulate by pointing to a wrong URL temporarily
                    original_url = BACKEND_URL
                    BACKEND_URL = "https://invalid-url-simulation.com"
                    time.sleep(10)
                    BACKEND_URL = original_url
                    log_debug("Network failure simulation ended. Syncing queue...", "INFO")
                
                elif test_type == 'CAMERA_DISCONNECT':
                    # Simulate by closing the capture
                    log_debug("Simulating camera disconnect...", "ERROR")
                    # The main loop will handle reconnection
                    return "DISCONNECT"
                
                elif test_type == 'MOTION_BLUR':
                    log_debug("Simulating motion blur (skipping frames)...", "DEBUG")
                    time.sleep(2) # Simulate processing delay/blur
                
                elif test_type == 'LOW_LIGHT':
                    log_debug("Simulating low light conditions...", "DEBUG")
                    # In a real simulation we'd darken the frame, 
                    # but here we just trigger the warning logic
                    pass

                safe_request("POST", f"{BACKEND_URL}/api/commands/{cmd['id']}/respond", 
                              json={"status": "completed"}, 
                              timeout=5)
    except Exception:
        pass

def log_debug(message, level="INFO"):
    """Send debug logs to backend for monitoring."""
    try:
        safe_request("POST", f"{BACKEND_URL}/api/debug-logs", 
                       json={"message": message, "level": level}, 
                       timeout=2)
    except:
        pass

def send_to_backend(plate, image_bytes):
    global offline_queue
    img_b64 = base64.b64encode(image_bytes).decode('utf-8')
    payload = {
        "vehicle_number": plate,
        "image": f"data:image/jpeg;base64,{img_b64}"
    }
    try:
        response = safe_request("POST", f"{BACKEND_URL}/log", json=payload, timeout=5)
        if response:
            return response.json()
        return {"success": False, "status": "queued"}
    except Exception as e:
        log_debug(f"Backend unreachable. Queuing log locally: {plate}", "WARNING")
        offline_queue.append(payload)
        # Limit queue size to prevent memory issues
        if len(offline_queue) > 100:
            offline_queue.pop(0)
        return {"success": False, "status": "queued"}

def call_gemini_ocr(image_bytes):
    """Call the backend's Gemini OCR endpoint for high-accuracy detection."""
    img_b64 = base64.b64encode(image_bytes).decode('utf-8')
    payload = {"image": img_b64}
    try:
        response = safe_request("POST", f"{BACKEND_URL}/api/gemini-ocr", json=payload, timeout=15)
        if response and response.status_code == 200:
            result = response.json()
            if result.get('isValid'):
                return result
        return None
    except Exception as e:
        return None

def cleanup_state():
    global vehicle_buffers, processed_ids, last_cleanup
    if time.time() - last_cleanup < 300: # Every 5 mins
        return
    last_cleanup = time.time()
    # Clear buffers for IDs that haven't been seen in a while
    # In a real tracker, IDs expire. Here we just reset periodically for stability.
    if len(vehicle_buffers) > 50:
        vehicle_buffers = {}
    if len(processed_ids) > 100:
        processed_ids = set()
    log_debug("Periodic memory cleanup performed", "DEBUG")

def process_roi(roi, track_id, full_frame, small_frame):
    global vehicle_buffers, processed_ids, frame_count, last_logged_plates, gemini_attempts
    if roi is None or roi.size == 0: return
    if track_id in processed_ids: return

    now = time.time()
    
    # --- SMART OCR TRIGGERING ---
    (h, w) = roi.shape[:2]
    # Only process if vehicle is close enough (ROI width > 150px in full frame)
    if w < 150: 
        return 

    # Initialize buffer for this vehicle
    if track_id not in vehicle_buffers:
        vehicle_buffers[track_id] = []

    # --- OPTIMIZED OCR ---
    processed = preprocess_image(roi)
    if processed is not None:
        try:
            # Using Tesseract for high-speed OCR
            text = pytesseract.image_to_string(processed, config=TESSERACT_CONFIG).strip()
            
            if text:
                plate = "".join(c for c in text if c.isalnum()).upper()
                if is_valid_indian_plate(plate):
                    # Check cooldown
                    if plate in last_logged_plates and (now - last_logged_plates[plate] < COOLDOWN_SECONDS):
                        processed_ids.add(track_id)
                        return

                    # Add to buffer for validation
                    vehicle_buffers[track_id].append(plate)
                    
                    # If we have enough consistent hits, log it
                    counts = Counter(vehicle_buffers[track_id])
                    most_common, count = counts.most_common(1)[0]
                    
                    if count >= VALIDATION_FRAMES:
                        _, buffer = cv2.imencode('.jpg', full_frame)
                        res = send_to_backend(most_common, buffer.tobytes())
                        if res and (res.get('success') or res.get('status') == 'queued'):
                            print(f"✅ IDENTIFIED (LOCAL): {most_common}")
                            processed_ids.add(track_id)
                            last_logged_plates[most_common] = now
                            return
            
            # --- GEMINI FALLBACK (If local OCR is struggling) ---
            # Try Gemini if we've seen the vehicle for a while but local OCR failed
            if len(vehicle_buffers[track_id]) >= 5 or (now - gemini_attempts.get(track_id, 0) > 3):
                gemini_attempts[track_id] = now
                _, buffer = cv2.imencode('.jpg', roi)
                gemini_res = call_gemini_ocr(buffer.tobytes())
                if gemini_res and gemini_res.get('isValid'):
                    plate = gemini_res['plate']
                    if plate in last_logged_plates and (now - last_logged_plates[plate] < COOLDOWN_SECONDS):
                        processed_ids.add(track_id)
                        return

                    _, full_buffer = cv2.imencode('.jpg', full_frame)
                    res = send_to_backend(plate, full_buffer.tobytes())
                    if res and (res.get('success') or res.get('status') == 'queued'):
                        print(f"✨ IDENTIFIED (GEMINI): {plate}")
                        processed_ids.add(track_id)
                        last_logged_plates[plate] = now
                        return

        except Exception as e:
            log_debug(f"OCR Error: {e}", "ERROR")

def start_ai_module():
    global vehicle_buffers, processed_ids, frame_count
    
    while True: # Outer loop for camera reconnection
        # 1. CHECK CAMERA REACHABILITY IF IT'S A URL
        if isinstance(CAMERA_SOURCE, str) and CAMERA_SOURCE.startswith('http'):
            print(f"🔍 Checking camera reachability at {CAMERA_SOURCE}...")
            try:
                # Just check the base IP/Port first
                cam_host = CAMERA_SOURCE.split('//')[1].split('/')[0]
                import socket
                host, port = cam_host.split(':')
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(3)
                s.connect((host, int(port)))
                s.close()
                print("✅ Camera port is reachable!")
            except Exception as e:
                print(f"❌ Camera at {CAMERA_SOURCE} is NOT reachable: {e}")
                print("💡 TIP: Ensure your phone and PC are on the same Wi-Fi network.")
                print("💡 TIP: Check if the IP address in smartgate_ai.py matches the one in the IP Webcam app.")
                time.sleep(5)
                continue

        # 2. OPEN CAMERA
        print(f"🎬 Opening camera stream...")
        cap = cv2.VideoCapture(CAMERA_SOURCE)
        if not cap.isOpened():
            print(f"❌ ERROR: Camera at {CAMERA_SOURCE} could not be opened.")
            print("💡 TIP: If using a USB webcam, try changing CAMERA_INDEX to 1 or 2.")
            print("💡 TIP: If using a phone, ensure the 'IP Webcam' server is running.")
            log_debug(f"Camera connection failed at {CAMERA_SOURCE}. Retrying...", "WARNING")
            time.sleep(5)
            continue

        print(f"✅ Camera Connected. Starting AI Monitor...")
        print(f"📡 Backend URL: {BACKEND_URL}")
        
        # 2. Initial checks (Non-blocking)
        print("🔍 Checking backend connectivity...")
        test_res = safe_request("GET", f"{BACKEND_URL}/api/health", timeout=10)
        if test_res:
            if test_res.status_code == 200:
                print("✅ Backend is reachable!")
            elif test_res.status_code == 503:
                print(f"⚠️  Backend is UP but DATABASE is DOWN (Status: 503)")
                print("💡 TIP: Check your MONGODB_URI in the AI Studio settings.")
            else:
                print(f"❌ Backend returned error code: {test_res.status_code}")
        else:
            print(f"❌ Backend is NOT reachable at {BACKEND_URL}")
            print("💡 TIP: You MUST click the 'Share' button in AI Studio to activate the 'ais-pre-' URL.")
            print("💡 TIP: Make sure your BACKEND_URL in smartgate_ai.py matches your Shared App URL.")
            print("💡 TIP: If you are running locally, ensure you have an active internet connection.")
            print("💡 TIP: The server might still be starting up (Cold Start).")
            
        send_heartbeat()
        fetch_settings()

        vehicle_detected = False # Initialize to prevent UnboundLocalError
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            # Show window IMMEDIATELY
            if not HEADLESS:
                cv2.imshow('SmartGate AI Production Monitor', frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    cap.release()
                    cv2.destroyAllWindows()
                    return

            frame_count += 1
            if frame_count % 100 == 0:
                print(f"--- Processing Frame {frame_count} ---")
                log_debug(f"AI Module Heartbeat: Processing frame {frame_count}", "DEBUG")
            
            send_heartbeat()
            cleanup_state()
            fetch_settings()

            # Dynamic Frame Skip: If we saw a vehicle recently, skip less
            current_skip = 1 if vehicle_detected else FRAME_SKIP
            if frame_count % current_skip != 0:
                continue

            # Resize for performance (but keep high enough for distance)
            h, w = frame.shape[:2]
            scale = RESIZE_WIDTH / w
            small_frame = cv2.resize(frame, (RESIZE_WIDTH, int(h * scale)))

            # Low-light detection
            brightness = calculate_brightness(small_frame)
            if brightness < 40:
                if frame_count % 100 == 0:
                    log_debug(f"Low light detected (Brightness: {brightness:.1f}). OCR accuracy may drop.", "WARNING")

            cmd_res = check_commands(frame)
            if cmd_res == "DISCONNECT":
                cap.release()
                break

            # 1. Vehicle Tracking
            results = model.track(small_frame, persist=True, verbose=False, stream=True)
            vehicle_detected = False
            
            for r in results:
                boxes = r.boxes
                if boxes.id is not None:
                    for box in boxes:
                        track_id = int(box.id[0])
                        cls = int(box.cls[0])
                        if cls in [2, 3, 5, 7]: # Car, Motorcycle, Bus, Truck
                            vehicle_detected = True
                            if track_id in processed_ids: continue
                            
                            # Get coordinates
                            x1, y1, x2, y2 = map(int, box.xyxy[0])
                            
                            # Extract ROI from original high-res frame for better OCR
                            h_orig, w_orig = frame.shape[:2]
                            h_small, w_small = small_frame.shape[:2]
                            
                            ry1, rx1 = int(y1 * h_orig / h_small), int(x1 * w_orig / w_small)
                            ry2, rx2 = int(y2 * h_orig / h_small), int(x2 * w_orig / w_small)
                            
                            # Focus on the lower half of the vehicle where plates usually are
                            # But also include a bit of the top for context
                            v_h_orig = ry2 - ry1
                            plate_roi_y1 = ry1 + int(v_h_orig * 0.2) # More context
                            
                            roi = frame[max(0, plate_roi_y1):min(h_orig, ry2), max(0, rx1):min(w_orig, rx2)]
                            process_roi(roi, track_id, frame, small_frame)

            # 2. Fallback: If no vehicle is tracked, check the whole frame (high-res)
            if not vehicle_detected:
                process_roi(frame, 999, frame, small_frame)

            # Optional: Display (Disable in headless production)
            if not HEADLESS:
                cv2.imshow('SmartGate AI Production Monitor', small_frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    cap.release()
                    cv2.destroyAllWindows()
                    return

        cap.release()
        cv2.destroyAllWindows()
        time.sleep(2)

if __name__ == "__main__":
    start_ai_module()
