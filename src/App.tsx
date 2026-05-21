  import React, { useState, useEffect, useCallback } from 'react';
import { 
  Car, 
  Bus, 
  Users, 
  History, 
  ShieldCheck, 
  Activity,
  User,
  Clock,
  Database as DbIcon,
  CheckCircle2,
  AlertCircle,
  Download,
  Filter,
  Terminal,
  Code,
  Camera,
  Settings as SettingsIcon,
  Zap,
  WifiOff,
  VideoOff,
  Wind,
  Moon,
  Bell,
  BarChart3,
  MapPin,
  LogOut,
  LogIn
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { io, Socket } from 'socket.io-client';
import { GoogleGenAI } from "@google/genai";

// --- Gemini Worker Logic ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

// Helper for Gemini OCR
const detectVehicleAndPlate = async (base64Image: string) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image,
              },
            },
            {
              text: `Analyze this vehicle entry image.
              1. Extract the vehicle license plate number (OCR).
              2. Identify the vehicle type (car, bus, truck, motorcycle).
              
              Rules:
              - Focus on Indian license plate formats.
              - Return ONLY a JSON object: {"plate": "NUMBER", "vehicle": "TYPE", "confidence": 0.9}.
              - If no plate is found, set plate to null.`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    if (!response.text) return { isValid: false };
    
    const result = JSON.parse(response.text.trim());
    const cleanPlate = result.plate ? result.plate.replace(/[^A-Z0-9]/gi, "").toUpperCase() : "";
    const indianPlateRegex = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/;
    const isValid = indianPlateRegex.test(cleanPlate);

    return {
      plate: cleanPlate,
      vehicle: result.vehicle,
      confidence: result.confidence || 0.8,
      isValid
    };
  } catch (err) {
    console.error("Gemini Frontend OCR Error:", err);
    return { isValid: false, error: String(err) };
  }
};

// --- Components ---

const StressCard = ({ title, desc, icon, onClick }: { title: string, desc: string, icon: React.ReactNode, onClick: () => void }) => (
  <button 
    onClick={onClick}
    className="flex items-start gap-4 p-4 rounded-xl border border-slate-200 hover:border-orange-200 hover:bg-orange-50 transition-all text-left group"
  >
    <div className="w-10 h-10 bg-white rounded-lg border border-slate-200 flex items-center justify-center group-hover:border-orange-200 group-hover:text-orange-600 transition-colors">
      {icon}
    </div>
    <div>
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      <p className="text-xs text-slate-500 mt-1 leading-relaxed">{desc}</p>
    </div>
  </button>
);

// Types
interface LogEntry {
  id: string;
  vehicle_number: string;
  type: string;
  owner_name?: string;
  department?: string;
  entry_time: string;
  exit_time?: string;
  duration?: string;
  image_data?: string;
  status?: string;
}

interface Alert {
  id: string;
  type: string;
  message: string;
  vehicle_number: string;
  timestamp: string;
  is_read: boolean;
}

interface Analytics {
  total_today: number;
  faculty_count: number;
  visitor_count: number;
  bus_count: number;
  inside_now: number;
  peak_hour: number;
  hourly_data: { hour: string; count: number }[];
}

interface Faculty {
  id: string;
  name: string;
  department: string;
  designation?: string;
  vehicle_number: string;
}

interface BusData {
  id: string;
  bus_number: string;
  driver_name: string;
  vehicle_number: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'logs' | 'registry' | 'setup' | 'debug' | 'stress' | 'inside' | 'analytics'>('dashboard');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [insideVehicles, setInsideVehicles] = useState<LogEntry[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [debugLogs, setDebugLogs] = useState<any[]>([]);
  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [buses, setBuses] = useState<BusData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [aiStatus, setAiStatus] = useState<{ status: string; last_seen: string | null }>({ status: 'OFFLINE', last_seen: null });
  const [dbStatus, setDbStatus] = useState({ connected: false, status: 'connecting' });
  const [settings, setSettings] = useState({ 
    ocr_confidence_threshold: 0.6, 
    validation_frames: 5, 
    cooldown_seconds: 60,
    alert_on_unknown: true,
    alert_on_frequent: true
  });

  // Registration form states
  const [newFaculty, setNewFaculty] = useState({ name: '', dept: '', plate: '', designation: '' });
  const [newBus, setNewBus] = useState({ number: '', driver: '', plate: '' });

  const [isServerStarting, setIsServerStarting] = useState(false);
  const [isWebCamActive, setIsWebCamActive] = useState(false);
  const [webCamError, setWebCamError] = useState<string | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const analyticsTimeoutRef = React.useRef<any>(null);
  const webCamIntervalRef = React.useRef<any>(null);

  const fetchWithRetry = async (url: string, options?: RequestInit, retries = 120): Promise<any> => {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      
      // Robust HTML detection
      const contentType = res.headers.get('content-type');
      const isHtmlHeader = contentType && contentType.includes('text/html');
      const isHtmlContent = /^\s*<!doctype html|^\s*<html/i.test(text);
      const isHtml = isHtmlHeader || isHtmlContent;
      
      const isStartingHtml = isHtml && (
        text.toLowerCase().includes('starting server') || 
        text.toLowerCase().includes('initializing') ||
        text.toLowerCase().includes('please wait') ||
        text.toLowerCase().includes('booting') ||
        text.toLowerCase().includes('<title>starting server...</title>') ||
        text.toLowerCase().includes('<title>initializing...</title>')
      );
      
      let data;
      try {
        if (isStartingHtml) {
          setIsServerStarting(true);
          throw new Error("Server is still starting up...");
        }
        
        if (isHtml && url.includes('/api/')) {
          // If we get HTML for an API route, it's almost certainly an error/startup page
          setIsServerStarting(true);
          throw new Error("Server returned HTML for an API route. Still starting up?");
        }

        data = JSON.parse(text);
      } catch (e) {
        // If it's a startup HTML or we're still retrying, don't log a noisy error yet
        if (isStartingHtml || isHtml || retries > 0) {
          if (isStartingHtml || isHtml) setIsServerStarting(true);
          const errorMsg = isStartingHtml || isHtml ? "Server is still starting up..." : `Invalid JSON response from ${url}`;
          throw new Error(errorMsg);
        }

        if (!res.ok) {
          console.error(`HTTP error! status: ${res.status}, body: ${text.substring(0, 200)}`);
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        console.error(`JSON Parse Error for ${url}:`, e, "Body starts with:", text.substring(0, 200));
        throw new Error(`Invalid JSON response from ${url}`);
      }

      if (!res.ok) {
        const errorMsg = data.message || data.error || `HTTP error! status: ${res.status}`;
        // If it's a 503 from our own startup middleware, we should retry
        if (res.status === 503 && retries > 0) {
          setIsServerStarting(true);
          throw new Error(errorMsg);
        }
        console.warn(`API Warning for ${url}: ${errorMsg}`);
        throw new Error(errorMsg);
      }
      
      setIsServerStarting(false);
      return data;
    } catch (err) {
      if (retries > 0) {
        const isStartup = err instanceof Error && (
          err.message.includes("starting") || 
          err.message.includes("Starting") || 
          err.message.includes("HTML for an API route") ||
          err.message.includes("Database connection not established") ||
          err.message.includes("ENOTFOUND") ||
          err.message.includes("MongooseServerSelectionError") ||
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("buffering timed out")
        );
        const delay = isStartup ? 5000 : 2000; // Wait longer for startup
        if (isStartup) setIsServerStarting(true);
        
        // Only log every 5th retry for startup to avoid flooding console
        if (!isStartup || retries % 5 === 0) {
          console.log(`Retrying ${url} in ${delay}ms... (${retries} left) - Reason: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, options, retries - 1);
      }
      throw err;
    }
  };

  const fetchAiStatus = async () => {
    try {
      const data = await fetchWithRetry('/api/status');
      setAiStatus(data);
      // Also update DB status from the ping/status response
      if (data.db) {
        setDbStatus({ 
          connected: data.db === 'connected', 
          status: data.db 
        });
      }
    } catch (err) {
      console.error('Fetch AI status error:', err);
    }
  };

  const clearDebugLogs = async () => {
    if (!confirm('Clear all system logs?')) return;
    try {
      await fetchWithRetry('/api/debug-logs/clear', { method: 'POST' });
      setDebugLogs([]);
    } catch (err) {
      console.error('Clear logs error:', err);
    }
  };

  const triggerStressTest = async (type: string) => {
    try {
      await fetchWithRetry('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'STRESS_TEST', payload: { test_type: type } })
      });
      alert(`Stress test command '${type}' sent to AI module.`);
    } catch (err) {
      console.error('Stress test error:', err);
    }
  };

  const fetchDebugLogs = async () => {
    try {
      const data = await fetchWithRetry('/api/debug-logs');
      setDebugLogs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Fetch debug logs error:', err);
    }
  };

  const fetchSettings = async () => {
    try {
      const data = await fetchWithRetry('/api/settings');
      if (data && !data.error) setSettings(data);
    } catch (err: any) {
      if (!err.message.includes("starting") && !err.message.includes("Database")) {
        console.error('Fetch settings error:', err);
      }
    }
  };

  const updateSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const data = await fetchWithRetry('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (data && !data.error) {
        setSettings(data);
        alert('Settings updated successfully!');
      }
    } catch (err) {
      console.error('Update settings error:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const data = await fetchWithRetry('/api/logs');
      setLogs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Fetch logs error:', err);
    }
  };

  const fetchInsideVehicles = async () => {
    try {
      const data = await fetchWithRetry('/api/inside-vehicles');
      setInsideVehicles(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Fetch inside vehicles error:', err);
    }
  };

  const fetchAlerts = async () => {
    try {
      const data = await fetchWithRetry('/api/alerts');
      setAlerts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Fetch alerts error:', err);
    }
  };

  const fetchAnalytics = async () => {
    try {
      const data = await fetchWithRetry('/api/analytics');
      setAnalytics(data);
    } catch (err) {
      console.error('Fetch analytics error:', err);
    }
  };

  const fetchFaculty = async () => {
    try {
      const data = await fetchWithRetry('/api/faculty');
      setFaculty(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Fetch faculty error:', err);
    }
  };

  const fetchBuses = async () => {
    try {
      const data = await fetchWithRetry('/api/buses');
      setBuses(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Fetch buses error:', err);
    }
  };

  const markAlertsAsRead = async () => {
    try {
      await fetchWithRetry('/api/alerts/read', { method: 'POST' });
      setAlerts(prev => prev.map(a => ({ ...a, is_read: true })));
    } catch (err) {
      console.error('Mark alerts as read error:', err);
    }
  };

  const captureFromWebCam = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !isWebCamActive) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Draw frame to canvas
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    
    try {
      // 1. Call Gemini OCR
      const ocrRes = await fetch('/api/gemini-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 })
      });
      
      if (!ocrRes.ok) return;
      const ocrData = await ocrRes.json();
      
      // 2. If valid plate found, log it
      if (ocrData.isValid && ocrData.plate) {
        const logRes = await fetch('/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vehicle_number: ocrData.plate,
            image: `data:image/jpeg;base64,${base64}`
          })
        });
        
        const logData = await logRes.json();
        if (logData.success) {
          fetchLogs(); // Refresh dashboard
        }
      }
    } catch (err) {
      console.error("Auto-capture error:", err);
    }
  }, [isWebCamActive, fetchLogs]);

  useEffect(() => {
    // Auto-start webcam on mount for fully automatic mode
    startWebCam();
    return () => stopWebCam();
  }, []);

  useEffect(() => {
    let hbInterval: any = null;
    if (isWebCamActive) {
      // Send initial heartbeat
      fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
      
      // Send heartbeat every 20 seconds to keep status ONLINE (server timeout is 30s)
      hbInterval = setInterval(() => {
        fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
      }, 20000);
    }
    return () => {
      if (hbInterval) clearInterval(hbInterval);
    };
  }, [isWebCamActive]);

  useEffect(() => {
    if (isWebCamActive) {
      webCamIntervalRef.current = setInterval(captureFromWebCam, 3000);
    } else {
      if (webCamIntervalRef.current) {
        clearInterval(webCamIntervalRef.current);
      }
    }
    return () => {
      if (webCamIntervalRef.current) {
        clearInterval(webCamIntervalRef.current);
      }
    };
  }, [isWebCamActive, captureFromWebCam]);

  const startWebCam = async () => {
    try {
      setWebCamError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsWebCamActive(true);
      }
    } catch (err) {
      console.error("Webcam error:", err);
      setWebCamError("Camera access denied. Please allow camera permissions.");
    }
  };

  const stopWebCam = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    if (webCamIntervalRef.current) {
      clearInterval(webCamIntervalRef.current);
    }
    setIsWebCamActive(false);
  };

  const addFaculty = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetchWithRetry('/api/add-faculty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: newFaculty.name, 
          department: newFaculty.dept, 
          vehicle_number: newFaculty.plate,
          designation: newFaculty.designation
        })
      });
      setNewFaculty({ name: '', dept: '', plate: '', designation: '' });
      fetchFaculty();
    } catch (err) {
      console.error('Add faculty error:', err);
    }
  };

  const addBus = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetchWithRetry('/api/add-bus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          bus_number: newBus.number, 
          driver_name: newBus.driver, 
          vehicle_number: newBus.plate 
        })
      });
      setNewBus({ number: '', driver: '', plate: '' });
      fetchBuses();
    } catch (err) {
      console.error('Add bus error:', err);
    }
  };

  const lastDetection = logs.length > 0 ? logs[0] : null;

  const fetchAllData = async () => {
    setIsLoading(true);
    try {
      // First, wait for the server to be alive with a simple ping
      // This prevents multiple simultaneous retries during startup
      await fetchWithRetry('/api/ping');
      
      await Promise.all([
        fetchLogs(), 
        fetchInsideVehicles(),
        fetchAlerts(),
        fetchAnalytics(),
        fetchFaculty(), 
        fetchBuses(), 
        fetchSettings(), 
        fetchDebugLogs(), 
        fetchAiStatus()
      ]);
      setIsServerStarting(false);
    } catch (err: any) {
      const isStartup = err.message.includes("starting") || 
                        err.message.includes("Starting") || 
                        err.message.includes("Database") ||
                        err.message.includes("ENOTFOUND") ||
                        err.message.includes("ECONNREFUSED");
      if (isStartup) {
        setIsServerStarting(true);
      }
    }
    setIsLoading(false);
  };

  const debouncedFetchAnalytics = useCallback(() => {
    if (analyticsTimeoutRef.current) clearTimeout(analyticsTimeoutRef.current);
    analyticsTimeoutRef.current = setTimeout(() => {
      fetchAnalytics();
    }, 1000); // 1s debounce
  }, []);

  // Socket.io setup
  useEffect(() => {
    if (isServerStarting) return;

    const socket = io();

    socket.on('connect', () => {
      console.log('Connected to server via Socket.io');
    });

    socket.on('log_new', (newLog: LogEntry) => {
      setLogs(prev => [newLog, ...prev].slice(0, 100));
      if (newLog.status === 'INSIDE') {
        setInsideVehicles(prev => [newLog, ...prev]);
      }
      debouncedFetchAnalytics(); // Refresh analytics on new entry
    });

    socket.on('log_update', (updatedLog: LogEntry) => {
      setLogs(prev => prev.map(l => l.id === updatedLog.id ? updatedLog : l));
      if (updatedLog.status === 'EXITED') {
        setInsideVehicles(prev => prev.filter(l => l.id !== updatedLog.id));
      } else {
        setInsideVehicles(prev => {
          const exists = prev.find(l => l.id === updatedLog.id);
          if (exists) return prev.map(l => l.id === updatedLog.id ? updatedLog : l);
          return [updatedLog, ...prev];
        });
      }
      debouncedFetchAnalytics(); // Refresh analytics on update
    });

    socket.on('alert_new', (newAlert: Alert) => {
      setAlerts(prev => [newAlert, ...prev].slice(0, 50));
    });

    socket.on('heartbeat', (data: { last_heartbeat: string }) => {
      setAiStatus({ status: 'ONLINE', last_seen: data.last_heartbeat as any });
    });

    socket.on('server_log', (log: any) => {
      setDebugLogs(prev => [log, ...prev].slice(0, 100));
    });

    // --- Gemini OCR Worker Logic ---
    socket.on('ocr_request', async (data: { requestId: string; image: string }) => {
      console.log(`[WORKER] Received OCR request: ${data.requestId}`);
      const result = await detectVehicleAndPlate(data.image);
      console.log(`[WORKER] OCR Result for ${data.requestId}:`, result);
      socket.emit('ocr_response', { requestId: data.requestId, result });
    });

    return () => {
      socket.disconnect();
    };
  }, [isServerStarting, debouncedFetchAnalytics]);

  useEffect(() => {
    fetchAllData();
  }, []);

  useEffect(() => {
    if (!isServerStarting && !isLoading) {
      const interval = setInterval(() => {
        // Fallback polling (less frequent now)
        fetchLogs();
        fetchInsideVehicles();
        fetchAlerts();
        fetchAnalytics();
        fetchDebugLogs();
        fetchAiStatus();
      }, 10000); // 10s fallback
      return () => clearInterval(interval);
    }
  }, [isServerStarting, isLoading]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-slate-200 flex items-center justify-between px-8 bg-white sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-200">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">SmartGate <span className="text-blue-600">AI</span></h1>
            <div className="flex items-center gap-1.5">
              {isServerStarting ? (
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600">Server Starting...</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${aiStatus.status === 'ONLINE' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${aiStatus.status === 'ONLINE' ? 'text-emerald-600' : 'text-red-600'}`}>
                    AI Module {aiStatus.status}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <nav className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
          {[
            { id: 'dashboard', label: 'Monitor', icon: Activity },
            { id: 'inside', label: 'Inside', icon: MapPin },
            { id: 'analytics', label: 'Analytics', icon: BarChart3 },
            { id: 'logs', label: 'History', icon: History },
            { id: 'registry', label: 'Registry', icon: DbIcon },
            { id: 'setup', label: 'AI Setup', icon: Terminal },
            { id: 'debug', label: 'System Logs', icon: Code },
            { id: 'stress', label: 'Stress Test', icon: Zap }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-semibold transition-all ${
                activeTab === tab.id 
                  ? 'bg-white text-blue-600 shadow-sm' 
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Server Status</div>
            <div className="text-xs font-semibold text-slate-700">Connected</div>
          </div>
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center border border-slate-200">
            <User className="w-4 h-4 text-slate-500" />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              {/* Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {[
                  { label: 'Inside Campus', value: insideVehicles.length, icon: MapPin, color: 'text-blue-600', bg: 'bg-blue-50' },
                  { label: 'Total Today', value: analytics?.total_today || 0, icon: History, color: 'text-indigo-600', bg: 'bg-indigo-50' },
                  { label: 'Active Alerts', value: alerts.filter(a => !a.is_read).length, icon: Bell, color: 'text-red-600', bg: 'bg-red-50' },
                  { label: 'Peak Hour', value: analytics ? `${analytics.peak_hour}:00` : '--', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' }
                ].map((stat, i) => (
                  <div key={i} className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                    <div className={`w-12 h-12 ${stat.bg} rounded-xl flex items-center justify-center`}>
                      <stat.icon className={`w-6 h-6 ${stat.color}`} />
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{stat.label}</div>
                      <div className="text-2xl font-bold text-slate-900">{stat.value}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Latest Detection & Recent Activity */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-6">
                  {/* Automatic Visitor Alert */}
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-amber-50/30">
                      <h2 className="text-sm font-bold flex items-center gap-2 text-amber-700">
                        <Activity className="w-4 h-4 animate-pulse" /> Live Visitor Entry
                      </h2>
                      <div className="flex items-center gap-2">
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-widest transition-all ${
                          isWebCamActive 
                            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' 
                            : 'bg-slate-100 text-slate-500 border border-slate-200'
                        }`}>
                          <Camera className="w-3 h-3" /> 
                          {isWebCamActive ? 'Auto-Monitor Active' : 'Camera Disconnected'}
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-2">Automatic Capture</span>
                      </div>
                    </div>
                    <div className="p-6">
                      {isWebCamActive && (
                        <div className="mb-6 bg-slate-900 rounded-2xl overflow-hidden border-4 border-emerald-500/30 relative aspect-video">
                          <video 
                            ref={videoRef} 
                            autoPlay 
                            playsInline 
                            className="w-full h-full object-cover"
                          />
                          <canvas ref={canvasRef} className="hidden" />
                          <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 bg-emerald-500 text-white rounded-full text-[10px] font-bold uppercase tracking-widest animate-pulse">
                            <Activity className="w-3 h-3" /> Live Monitoring Active
                          </div>
                          <div className="absolute bottom-4 right-4 text-[9px] text-white/50 font-mono">
                            Auto-scanning every 3s...
                          </div>
                        </div>
                      )}
                      
                      {webCamError && (
                        <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-xs flex items-center gap-3">
                          <AlertCircle className="w-4 h-4" />
                          {webCamError}
                        </div>
                      )}

                      {logs.find(l => l.type === 'Visitor') ? (
                        <div className="flex flex-col md:flex-row gap-6 items-center">
                          <div className="flex-1 space-y-4">
                            <div className="flex items-center gap-2 text-amber-600 font-bold text-sm">
                              <AlertCircle className="w-5 h-5" />
                              NEW VISITOR DETECTED
                            </div>
                            <div>
                              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Plate Number</div>
                              <div className="text-2xl font-black text-slate-900 font-mono tracking-tighter">
                                {logs.find(l => l.type === 'Visitor')?.vehicle_number}
                              </div>
                            </div>
                            <div className="text-xs text-slate-500">
                              Captured at: {(() => {
                                const visitor = logs.find(l => l.type === 'Visitor');
                                return visitor ? new Date(visitor.entry_time).toLocaleTimeString() : 'N/A';
                              })()}
                            </div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                              Live Feed Active
                            </div>
                          </div>
                          <div className="w-full md:w-64 aspect-video bg-slate-100 rounded-xl overflow-hidden border border-slate-200 relative group">
                            <img 
                              src={logs.find(l => l.type === 'Visitor')?.image_data} 
                              alt="Visitor" 
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <button 
                                onClick={() => window.open(logs.find(l => l.type === 'Visitor')?.image_data, '_blank')}
                                className="p-2 bg-white rounded-full shadow-lg"
                              >
                                <Download className="w-4 h-4 text-slate-900" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="py-12 text-center space-y-4">
                          <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto">
                            <ShieldCheck className="w-8 h-8 text-slate-300" />
                          </div>
                          <p className="text-xs text-slate-400 font-medium tracking-wide uppercase">Waiting for visitor entry...</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden h-full">
                    <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                      <h2 className="text-sm font-bold flex items-center gap-2">
                        <Activity className="w-4 h-4 text-blue-600" /> Latest Identification
                      </h2>
                      {lastDetection && (
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                          {new Date(lastDetection.entry_time).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                    
                    <div className="p-8">
                      {lastDetection ? (
                        <div className="flex flex-col md:flex-row gap-8 items-center">
                          <div className="flex-1 space-y-6">
                            <div className="flex items-center gap-4">
                              <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                lastDetection.type === 'Faculty' ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' :
                                lastDetection.type === 'College Bus' ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' :
                                'bg-amber-50 text-amber-600 border border-amber-100'
                              }`}>
                                {lastDetection.type}
                              </div>
                              <div className="text-xs font-medium text-slate-400">
                                {new Date(lastDetection.entry_time).toLocaleString()}
                              </div>
                            </div>
                            
                            <div>
                              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Vehicle Number</div>
                              <div className="text-4xl font-black text-slate-900 tracking-tighter font-mono">
                                {lastDetection.vehicle_number}
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Owner</div>
                                <div className="text-sm font-bold text-slate-700">{lastDetection.owner_name || 'Unknown'}</div>
                              </div>
                              <div>
                                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Department / ID</div>
                                <div className="text-sm font-bold text-slate-700">{lastDetection.department || 'N/A'}</div>
                              </div>
                            </div>

                            <div className="flex items-center gap-4">
                              <div className={`flex items-center gap-2 font-bold text-sm ${lastDetection.status === 'INSIDE' ? 'text-emerald-600' : 'text-blue-600'}`}>
                                {lastDetection.status === 'INSIDE' ? <LogIn className="w-5 h-5" /> : <LogOut className="w-5 h-5" />}
                                {lastDetection.status}
                              </div>
                              {lastDetection.duration && (
                                <div className="flex items-center gap-2 text-slate-500 font-bold text-sm">
                                  <Clock className="w-5 h-5" />
                                  {lastDetection.duration}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="w-full md:w-64 aspect-video bg-slate-100 rounded-2xl overflow-hidden border border-slate-200 flex items-center justify-center">
                            {lastDetection.image_data ? (
                              <img src={lastDetection.image_data} alt="Vehicle" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <Car className="w-12 h-12 text-slate-300" />
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="py-20 flex flex-col items-center justify-center text-slate-400">
                          <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                            <Clock className="w-8 h-8 animate-pulse" />
                          </div>
                          <p className="text-sm font-medium">Waiting for vehicle data from Local AI module...</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-4 space-y-6">
                  {/* Alerts Section */}
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                      <h2 className="text-sm font-bold flex items-center gap-2">
                        <Bell className="w-4 h-4 text-red-500" /> Security Alerts
                      </h2>
                      {alerts.some(a => !a.is_read) && (
                        <button 
                          onClick={markAlertsAsRead}
                          className="text-[10px] font-bold text-blue-600 uppercase tracking-widest hover:underline"
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[300px]">
                      {alerts.length > 0 ? alerts.map((alert) => (
                        <div key={alert.id} className={`p-3 rounded-xl border transition-all ${alert.is_read ? 'bg-slate-50 border-slate-100 opacity-60' : 'bg-red-50 border-red-100'}`}>
                          <div className="flex items-start gap-3">
                            <div className={`mt-0.5 p-1.5 rounded-lg ${alert.is_read ? 'bg-slate-200 text-slate-500' : 'bg-red-100 text-red-600'}`}>
                              <AlertCircle className="w-3.5 h-3.5" />
                            </div>
                            <div>
                              <div className="text-xs font-bold text-slate-900">{alert.message}</div>
                              <div className="text-[10px] text-slate-400 mt-1">{new Date(alert.timestamp).toLocaleTimeString()}</div>
                            </div>
                          </div>
                        </div>
                      )) : (
                        <div className="py-8 text-center text-slate-400 text-xs">No active alerts</div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-slate-100">
                      <h2 className="text-sm font-bold flex items-center gap-2">
                        <History className="w-4 h-4 text-slate-400" /> Recent Activity
                      </h2>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[300px]">
                      {logs.slice(0, 10).map((log) => (
                        <div key={log.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between group hover:border-blue-200 transition-all">
                          <div>
                            <div className="text-xs font-bold text-slate-900 font-mono">{log.vehicle_number}</div>
                            <div className="text-[10px] text-slate-400">{log.type} • {new Date(log.entry_time).toLocaleTimeString()}</div>
                          </div>
                          <div className="w-8 h-8 bg-white rounded-lg border border-slate-200 flex items-center justify-center">
                            {log.type === 'Faculty' ? <Users className="w-4 h-4 text-indigo-500" /> : 
                             log.type === 'College Bus' ? <Bus className="w-4 h-4 text-emerald-500" /> : 
                             <User className="w-4 h-4 text-amber-500" />}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'inside' && (
            <motion.div 
              key="inside"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                  <div>
                    <h2 className="text-sm font-bold">Vehicles Currently Inside Campus</h2>
                    <p className="text-xs text-slate-500 mt-1">Real-time list of vehicles that have entered but not yet exited.</p>
                  </div>
                  <div className="px-4 py-2 bg-blue-50 text-blue-600 rounded-xl text-xs font-bold">
                    {insideVehicles.length} Vehicles
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
                  {insideVehicles.length > 0 ? insideVehicles.map((vehicle) => (
                    <div key={vehicle.id} className="p-4 rounded-2xl border border-slate-100 bg-slate-50/50 flex items-center gap-4 hover:border-blue-200 transition-all">
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-slate-200 flex-shrink-0">
                        {vehicle.image_data ? (
                          <img src={vehicle.image_data} alt={vehicle.vehicle_number} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><Car className="w-6 h-6 text-slate-400" /></div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-900 font-mono truncate">{vehicle.vehicle_number}</div>
                        <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{vehicle.type}</div>
                        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-slate-400">
                          <Clock className="w-3 h-3" />
                          Entered {new Date(vehicle.entry_time).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                  )) : (
                    <div className="col-span-full py-20 text-center text-slate-400">
                      <MapPin className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      <p className="text-sm font-medium">No vehicles currently inside campus.</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'analytics' && (
            <motion.div 
              key="analytics"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-bold mb-6 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-blue-600" /> Hourly Entry Traffic (Today)
                  </h3>
                  <div className="h-[300px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={analytics?.hourly_data || []}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis 
                          dataKey="hour" 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{ fontSize: 10, fill: '#94a3b8' }} 
                        />
                        <YAxis 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{ fontSize: 10, fill: '#94a3b8' }} 
                        />
                        <Tooltip 
                          cursor={{ fill: '#f8fafc' }}
                          contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                        />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {(analytics?.hourly_data || []).map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={index === analytics?.peak_hour ? '#2563eb' : '#94a3b8'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col">
                  <h3 className="text-sm font-bold mb-6">Vehicle Distribution</h3>
                  <div className="space-y-6 flex-1 flex flex-col justify-center">
                    {[
                      { label: 'Faculty', count: analytics?.faculty_count || 0, color: 'bg-indigo-500', total: analytics?.total_today || 1 },
                      { label: 'College Bus', count: analytics?.bus_count || 0, color: 'bg-emerald-500', total: analytics?.total_today || 1 },
                      { label: 'Visitors', count: analytics?.visitor_count || 0, color: 'bg-amber-500', total: analytics?.total_today || 1 }
                    ].map((item, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between items-end">
                          <span className="text-xs font-bold text-slate-700">{item.label}</span>
                          <span className="text-xs font-black text-slate-900">{item.count}</span>
                        </div>
                        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${(item.count / item.total) * 100}%` }}
                            className={`h-full ${item.color}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-8 pt-6 border-t border-slate-100">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Summary</div>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Peak traffic observed at <strong>{analytics?.peak_hour}:00</strong> today. 
                      <strong> {((analytics?.visitor_count || 0) / (analytics?.total_today || 1) * 100).toFixed(0)}%</strong> of total entries are visitors.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'logs' && (
            <motion.div 
              key="logs"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                <h2 className="text-sm font-bold">Comprehensive Logs</h2>
                <button className="px-4 py-2 bg-slate-100 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-200 transition-all flex items-center gap-2">
                  <Download className="w-3.5 h-3.5" /> Export Data
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50/50 border-b border-slate-100">
                      <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Entry Time</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Exit Time</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Vehicle Number</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Owner Details</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Duration</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {logs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="text-xs font-bold text-slate-700">{new Date(log.entry_time).toLocaleDateString()}</div>
                          <div className="text-[10px] text-slate-400">{new Date(log.entry_time).toLocaleTimeString()}</div>
                        </td>
                        <td className="px-6 py-4">
                          {log.exit_time ? (
                            <>
                              <div className="text-xs font-bold text-slate-700">{new Date(log.exit_time).toLocaleDateString()}</div>
                              <div className="text-[10px] text-slate-400">{new Date(log.exit_time).toLocaleTimeString()}</div>
                            </>
                          ) : (
                            <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Still Inside</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs font-bold text-slate-900 font-mono tracking-wider">{log.vehicle_number}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs font-bold text-slate-700">{log.owner_name || 'Unknown'}</div>
                          <div className="text-[10px] text-slate-400">{log.department || 'N/A'}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs font-bold text-slate-600">{log.duration || '--'}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className={`text-[10px] font-bold flex items-center gap-1 ${log.status === 'INSIDE' ? 'text-blue-600' : 'text-emerald-600'}`}>
                            {log.status === 'INSIDE' ? <LogIn className="w-3 h-3" /> : <LogOut className="w-3 h-3" />}
                            {log.status}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

          {activeTab === 'registry' && (
            <motion.div 
              key="registry"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-1 md:grid-cols-2 gap-8"
            >
              {/* Faculty Registry */}
              <div className="space-y-6">
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-bold mb-6 flex items-center gap-2">
                    <Users className="w-4 h-4 text-blue-600" /> Register Faculty
                  </h3>
                  <form onSubmit={addFaculty} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Name</label>
                        <input 
                          type="text" 
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
                          value={newFaculty.name}
                          onChange={e => setNewFaculty({...newFaculty, name: e.target.value})}
                          required
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Department</label>
                        <input 
                          type="text" 
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
                          value={newFaculty.dept}
                          onChange={e => setNewFaculty({...newFaculty, dept: e.target.value})}
                          required
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Vehicle Number</label>
                      <input 
                        type="text" 
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/20"
                        placeholder="TN 01 AB 1234"
                        value={newFaculty.plate}
                        onChange={e => setNewFaculty({...newFaculty, plate: e.target.value})}
                        required
                      />
                    </div>
                    <button type="submit" className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-blue-700 transition-all">
                      Add to Registry
                    </button>
                  </form>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="p-4 bg-slate-50 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    Registered Faculty ({faculty.length})
                  </div>
                  <div className="max-h-[300px] overflow-y-auto divide-y divide-slate-50">
                    {faculty.map(f => (
                      <div key={f.id} className="p-4 flex justify-between items-center">
                        <div>
                          <div className="text-xs font-bold text-slate-900">{f.name}</div>
                          <div className="text-[10px] text-slate-400">{f.department}</div>
                        </div>
                        <div className="text-xs font-bold font-mono text-slate-600">{f.vehicle_number}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Bus Registry */}
              <div className="space-y-6">
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-bold mb-6 flex items-center gap-2">
                    <Bus className="w-4 h-4 text-emerald-600" /> Register College Bus
                  </h3>
                  <form onSubmit={addBus} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Bus ID</label>
                        <input 
                          type="text" 
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/20"
                          value={newBus.number}
                          onChange={e => setNewBus({...newBus, number: e.target.value})}
                          required
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Driver Name</label>
                        <input 
                          type="text" 
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/20"
                          value={newBus.driver}
                          onChange={e => setNewBus({...newBus, driver: e.target.value})}
                          required
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Vehicle Number</label>
                      <input 
                        type="text" 
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-emerald-500/20"
                        placeholder="TN 01 AB 5678"
                        value={newBus.plate}
                        onChange={e => setNewBus({...newBus, plate: e.target.value})}
                        required
                      />
                    </div>
                    <button type="submit" className="w-full py-3 bg-emerald-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-emerald-700 transition-all">
                      Register Bus
                    </button>
                  </form>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="p-4 bg-slate-50 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    Registered Buses ({buses.length})
                  </div>
                  <div className="max-h-[300px] overflow-y-auto divide-y divide-slate-50">
                    {buses.map(b => (
                      <div key={b.id} className="p-4 flex justify-between items-center">
                        <div>
                          <div className="text-xs font-bold text-slate-900">{b.bus_number}</div>
                          <div className="text-[10px] text-slate-400">Driver: {b.driver_name}</div>
                        </div>
                        <div className="text-xs font-bold font-mono text-slate-600">{b.vehicle_number}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'setup' && (
            <motion.div 
              key="setup"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-3xl mx-auto"
            >
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                  <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-xl shadow-blue-100">
                    <Terminal className="w-8 h-8 text-white" />
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Local AI Module Setup</h2>
                  <p className="text-slate-500 mt-2">Follow these steps to connect your local camera and AI processing to this dashboard.</p>
                </div>
                
                <div className="p-8 space-y-8">
                  <section className="bg-blue-50 border border-blue-100 rounded-2xl p-6">
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-2 text-blue-900">
                      <Zap className="w-4 h-4 text-blue-600" /> Critical: Activate Shared URL
                    </h3>
                    <p className="text-xs text-blue-700 leading-relaxed">
                      To allow your local script to connect, you <strong>MUST</strong> click the <strong>Share</strong> button in the top right of AI Studio. 
                      This activates the <code className="bg-blue-100 px-1 rounded">ais-pre-</code> URL and bypasses the browser cookie check.
                    </p>
                  </section>

                  <section>
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-4">
                      <div className="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-[10px]">1</div>
                      Install Dependencies
                    </h3>
                    <div className="bg-slate-900 rounded-xl p-4 font-mono text-xs text-blue-400 overflow-x-auto">
                      pip install ultralytics easyocr opencv-python requests
                    </div>
                  </section>

                  <section>
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-4">
                      <div className="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-[10px]">2</div>
                      Python AI Script
                    </h3>
                    <p className="text-xs text-slate-500 mb-4">Create a file named <code className="bg-slate-100 px-1 rounded text-blue-600">smartgate_ai.py</code> and paste the code provided in the project files.</p>
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Code className="w-5 h-5 text-slate-400" />
                        <span className="text-xs font-medium text-slate-600">smartgate_ai.py</span>
                      </div>
                      <span className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Ready in Files</span>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-4">
                      <div className="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-[10px]">3</div>
                      Run the Module
                    </h3>
                    <div className="bg-slate-900 rounded-xl p-4 font-mono text-xs text-blue-400 overflow-x-auto space-y-2">
                      <p># 1. Open a SECOND terminal</p>
                      <p># 2. Set the Backend URL (Required for AI Studio):</p>
                      <p className="text-emerald-400">export BASE_URL="{window.location.origin.replace('ais-dev-', 'ais-pre-')}"</p>
                      <p># 3. Run the script:</p>
                      <p>python smartgate_ai.py</p>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-4 flex items-center gap-2">
                      <AlertCircle className="w-3 h-3" />
                      Ensure your local server is running on port 3000 in Terminal 1.
                    </p>
                  </section>

                  <section className="bg-emerald-50 border border-emerald-100 rounded-2xl p-6">
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-3 text-emerald-900">
                      <Camera className="w-4 h-4 text-emerald-600" /> Use Phone as Camera
                    </h3>
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="w-5 h-5 bg-emerald-200 rounded-full flex items-center justify-center text-[10px] font-bold text-emerald-700 mt-0.5">1</div>
                        <p className="text-xs text-emerald-800">Install <strong>"IP Webcam"</strong> app on your Android phone.</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-5 h-5 bg-emerald-200 rounded-full flex items-center justify-center text-[10px] font-bold text-emerald-700 mt-0.5">2</div>
                        <p className="text-xs text-emerald-800">Open the app, scroll to the bottom, and click <strong>"Start Server"</strong>.</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-5 h-5 bg-emerald-200 rounded-full flex items-center justify-center text-[10px] font-bold text-emerald-700 mt-0.5">3</div>
                        <p className="text-xs text-emerald-800">Note the IP address (e.g., <code className="bg-emerald-100 px-1 rounded">192.168.1.5</code>) shown on the phone screen.</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-5 h-5 bg-emerald-200 rounded-full flex items-center justify-center text-[10px] font-bold text-emerald-700 mt-0.5">4</div>
                        <p className="text-xs text-emerald-800">In <code className="bg-emerald-100 px-1 rounded">smartgate_ai.py</code>, set <code className="bg-emerald-100 px-1 rounded">PHONE_IP = "192.168.1.5"</code> (replace with your IP).</p>
                      </div>
                    </div>
                  </section>

                  <section className="pt-8 border-t border-slate-100">
                    <h3 className="text-sm font-bold flex items-center gap-2 mb-6">
                      <SettingsIcon className="w-4 h-4 text-blue-600" /> AI Configuration
                    </h3>
                    <form onSubmit={updateSettings} className="space-y-6 bg-slate-50 p-6 rounded-2xl border border-slate-100">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                            OCR Confidence Threshold ({settings.ocr_confidence_threshold})
                          </label>
                          <input 
                            type="range" 
                            min="0.1" 
                            max="1.0" 
                            step="0.05"
                            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                            value={settings.ocr_confidence_threshold}
                            onChange={e => setSettings({...settings, ocr_confidence_threshold: parseFloat(e.target.value)})}
                          />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1 font-bold">
                            <span>0.1 (Loose)</span>
                            <span>1.0 (Strict)</span>
                          </div>
                        </div>

                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                            Validation Frames ({settings.validation_frames})
                          </label>
                          <input 
                            type="number" 
                            min="1" 
                            max="10"
                            className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
                            value={settings.validation_frames}
                            onChange={e => setSettings({...settings, validation_frames: parseInt(e.target.value)})}
                          />
                          <p className="text-[9px] text-slate-400 mt-1">Number of consistent reads required before logging.</p>
                        </div>

                        <div>
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                            Cooldown Period (Seconds)
                          </label>
                          <input 
                            type="number" 
                            min="5" 
                            max="3600"
                            className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
                            value={settings.cooldown_seconds}
                            onChange={e => setSettings({...settings, cooldown_seconds: parseInt(e.target.value)})}
                          />
                        </div>
                      </div>
                      <button type="submit" className="px-6 py-2.5 bg-slate-900 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-slate-800 transition-all">
                        Save Configuration
                      </button>
                    </form>
                  </section>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'stress' && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-4xl mx-auto space-y-6"
            >
              <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center">
                    <Zap className="w-5 h-5 text-orange-600" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">Resilience Stress Testing</h2>
                    <p className="text-sm text-slate-500">Simulate real-world edge cases to verify system stability.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <StressCard 
                    title="Network Failure" 
                    desc="Simulate backend unreachability. AI should queue logs locally."
                    icon={<WifiOff className="w-5 h-5" />}
                    onClick={() => triggerStressTest('NETWORK_FAILURE')}
                  />
                  <StressCard 
                    title="Camera Disconnect" 
                    desc="Simulate loss of video feed. AI should enter retry loop."
                    icon={<VideoOff className="w-5 h-5" />}
                    onClick={() => triggerStressTest('CAMERA_DISCONNECT')}
                  />
                  <StressCard 
                    title="Motion Blur" 
                    desc="Simulate high-speed vehicle blur. Tests multi-frame validation."
                    icon={<Wind className="w-5 h-5" />}
                    onClick={() => triggerStressTest('MOTION_BLUR')}
                  />
                  <StressCard 
                    title="Low Light" 
                    desc="Simulate night conditions. Tests brightness detection and preprocessing."
                    icon={<Moon className="w-5 h-5" />}
                    onClick={() => triggerStressTest('LOW_LIGHT')}
                  />
                </div>

                <div className="mt-8 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div className="text-xs text-slate-600 leading-relaxed">
                      <p className="font-bold text-slate-900 mb-1">How it works:</p>
                      These commands instruct the AI module to simulate specific failure states. 
                      Monitor the <span className="font-bold">System Logs</span> tab to see how the AI handles these events. 
                      The AI is designed to recover automatically from all simulated failures.
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'debug' && (
            <motion.div 
              key="debug"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden">
              <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-blue-400" /> System Debug Console
                </h2>
                <div className="flex items-center gap-4">
                  <button 
                    onClick={clearDebugLogs}
                    className="px-3 py-1 bg-slate-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400 rounded-lg text-[10px] font-bold transition-all border border-slate-700"
                  >
                    Clear Logs
                  </button>
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Real-time Stream</span>
                  <button 
                    onClick={fetchDebugLogs}
                    className="p-1.5 hover:bg-slate-800 rounded-lg transition-colors"
                  >
                    <Activity className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
              </div>
              <div className="p-4 font-mono text-[11px] h-[600px] overflow-y-auto bg-slate-950 space-y-1">
                {debugLogs.length > 0 ? debugLogs.map((log, index) => (
                  <div key={log.id || `log-${index}`} className="flex gap-4 py-0.5 border-b border-slate-900/50 hover:bg-slate-900/50 transition-colors">
                    <span className="text-slate-600 shrink-0">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className={`font-bold shrink-0 w-16 ${
                      log.level === 'ERROR' ? 'text-red-500' : 
                      log.level === 'WARNING' ? 'text-amber-500' : 
                      log.level === 'DEBUG' ? 'text-slate-500' : 'text-blue-400'
                    }`}>{log.level}</span>
                    <span className="text-slate-300">{log.message}</span>
                  </div>
                )) : (
                  <div className="text-slate-600 italic py-8 text-center">No system logs available. Start the AI module to see activity.</div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>

      {/* Footer */}
      <footer className="p-6 border-t border-slate-200 bg-white text-center">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.3em]">
          SmartGate AI • Enterprise Security System • v2.0.4
        </p>
      </footer>
    </div>
  );
}
