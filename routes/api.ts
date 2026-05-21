import express from 'express';
import { Faculty, Bus, Log, Heartbeat, Settings } from '../models/vehicle';
import { ocrBridge } from '../lib/ocrBridge';

const router = express.Router();

// Health/Ping Endpoints
router.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development' });
});

router.get('/api/ping', (req, res) => {
  res.json({ pong: true });
});

// Heartbeat for AI Module status
router.post('/api/heartbeat', async (req: any, res) => {
  try {
    const now = new Date();
    await Heartbeat.findOneAndUpdate({}, { last_heartbeat: now }, { upsert: true });
    if (req.io) {
      req.io.emit('heartbeat', { last_heartbeat: now });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status -> check if AI is online
router.get('/api/status', async (req, res) => {
  try {
    const hb = await Heartbeat.findOne().sort({ last_heartbeat: -1 });
    const lastHeartbeat = hb?.last_heartbeat;
    const isOnline = lastHeartbeat ? (Date.now() - new Date(lastHeartbeat).getTime() < 30000) : false;
    res.json({ 
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      last_seen: lastHeartbeat
    });
  } catch (err: any) {
    res.json({ status: 'OFFLINE', error: err.message });
  }
});

// Gemini OCR Route (Delegated to Frontend)
router.post('/api/gemini-ocr', async (req: any, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "Image data required" });
    
    if (!req.io) {
      return res.status(503).json({ error: "Real-time communication bridge not ready" });
    }

    // Check if any clients are connected
    const connectedSockets = await req.io.fetchSockets();
    if (connectedSockets.length === 0) {
      return res.status(403).json({ error: "No active dashboard detected. Open the site in your browser first." });
    }

    const requestId = Math.random().toString(36).substring(7);
    
    // Listen for completion
    const onCompletion = (result: any) => {
        res.json(result);
        clearTimeout(timeout);
    };

    // Set a timeout
    const timeout = setTimeout(() => {
        ocrBridge.off(`ocr_completed_${requestId}`, onCompletion);
        res.status(504).json({ error: "OCR request timed out. Make sure the SmartGate Dashboard is open in your browser." });
    }, 45000);

    ocrBridge.once(`ocr_completed_${requestId}`, onCompletion);
    req.io.emit('ocr_request', { requestId, image });
    console.log(`[OCR] Request ${requestId} sent to dashboard`);

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /log -> store vehicle data
router.post('/log', async (req, res) => {
  try {
    const { vehicle_number, timestamp, image } = req.body;
    if (!vehicle_number) return res.status(400).json({ error: "Vehicle number required" });

    const plate = vehicle_number.toUpperCase().replace(/\s/g, '');
    const now = new Date();

    // Prevent duplicate entries (60 sec cooldown)
    const lastLog = await Log.findOne({ vehicle_number: plate }).sort({ entry_time: -1 });
    if (lastLog) {
      const diff = now.getTime() - new Date(lastLog.entry_time).getTime();
      if (diff < 60000) {
        return res.json({ status: "skipped", message: "Cooldown active (60s)" });
      }
    }

    // Categorize vehicle
    let type = "Visitor";
    const faculty = await Faculty.findOne({ vehicle_number: plate });
    const bus = await Bus.findOne({ vehicle_number: plate });

    if (faculty) {
      type = "Faculty";
    } else if (bus) {
      type = "College Bus";
    }

    const log = await Log.create({
      vehicle_number: plate,
      type,
      timestamp: timestamp || now.toISOString(),
      image,
      entry_time: now
    });

    if ((req as any).io) {
      (req as any).io.emit('log_new', log);
    }

    console.log(`[LOG] ${type} detected: ${plate}`);
    res.json({ success: true, log });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs -> return all logs
router.get('/api/logs', async (req, res) => {
  try {
    const logs = await Log.find().sort({ entry_time: -1 });
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inside-vehicles
router.get('/api/inside-vehicles', async (req, res) => {
  try {
    // For now, just return all logs as "inside" or implement status logic
    const logs = await Log.find().sort({ entry_time: -1 }).limit(10);
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts
router.get('/api/alerts', async (req, res) => {
  try {
    res.json([]); // Placeholder for alerts
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics
router.get('/api/analytics', async (req, res) => {
  try {
    const total = await Log.countDocuments();
    const faculty = await Log.countDocuments({ type: 'Faculty' });
    const bus = await Log.countDocuments({ type: 'College Bus' });
    const visitor = await Log.countDocuments({ type: 'Visitor' });
    
    res.json({
      total_today: total,
      faculty_count: faculty,
      bus_count: bus,
      visitor_count: visitor,
      inside_now: total, // Placeholder
      hourly_data: []
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/faculty
router.get('/api/faculty', async (req, res) => {
  try {
    const faculty = await Faculty.find();
    res.json(faculty);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/add-faculty
router.post('/api/add-faculty', async (req, res) => {
  try {
    const { name, department, vehicle_number } = req.body;
    const plate = vehicle_number.toUpperCase().replace(/\s/g, '');
    const faculty = await Faculty.create({ name, department, vehicle_number: plate });
    res.json(faculty);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/buses
router.get('/api/buses', async (req, res) => {
  try {
    const buses = await Bus.find();
    res.json(buses);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/add-bus
router.post('/api/add-bus', async (req, res) => {
  try {
    const { bus_number, driver_name, vehicle_number } = req.body;
    const plate = vehicle_number.toUpperCase().replace(/\s/g, '');
    const bus = await Bus.create({ bus_number, driver_name, vehicle_number: plate });
    res.json(bus);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings
router.get('/api/settings', async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({});
    }
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings
router.post('/api/settings', async (req, res) => {
  try {
    const settings = await Settings.findOneAndUpdate({}, req.body, { upsert: true, new: true });
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
