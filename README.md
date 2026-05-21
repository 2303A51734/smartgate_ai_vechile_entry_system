# SmartGate AI: Smart Vehicle Entry Management System

A production-ready AI-based vehicle entry management system.

## System Architecture
1. **Frontend**: React-based dashboard for real-time monitoring and management.
2. **Backend**: Node.js (Express) backend for high-speed API processing and database management.
3. **Local AI Monitor**: Python-based script (YOLOv8) for real-time camera feeds.

## Features
- **FastAPI-style API**: Exposes endpoints compatible with any HTTP client (Python, JS, etc.).
- **Real-time Heartbeat**: Monitor the connection status of your local AI cameras.
- **Settings Sync**: Change camera thresholds and cooldowns directly from the dashboard.
- **Secure Integration**: Bypasses browser session requirements for Python scripts.

## Core API Endpoints
- `GET /api/health`: System health check.
- `POST /api/heartbeat`: Signal camera activity.
- `GET /api/settings`: Fetch current AI configurations.
- `POST /log`: Register a vehicle detection.

## Local AI Setup
1. **Connect Script**: Run `python smartgate_detector.py` on your local machine.
2. **Configuration**: Set `BACKEND_URL` in your environment to match this app's URL.
3. **Dependencies**: `pip install ultralytics requests python-socketio opencv-python`.
