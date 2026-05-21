import mongoose from 'mongoose';

const FacultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  department: { type: String, required: true },
  vehicle_number: { type: String, required: true, unique: true }
}, { collection: 'faculty_vehicles' });

const BusSchema = new mongoose.Schema({
  bus_number: { type: String, required: true },
  driver_name: { type: String, required: true },
  vehicle_number: { type: String, required: true, unique: true }
}, { collection: 'college_buses' });

const LogSchema = new mongoose.Schema({
  vehicle_number: { type: String, required: true },
  type: { type: String, required: true }, // Faculty, College Bus, Visitor
  entry_time: { type: Date, default: Date.now },
  timestamp: { type: String }, // For compatibility with Python module
  image: { type: String }
}, { collection: 'vehicle_logs' });

export const Faculty = mongoose.model('Faculty', FacultySchema);
export const Bus = mongoose.model('Bus', BusSchema);
export const Log = mongoose.model('Log', LogSchema);

const HeartbeatSchema = new mongoose.Schema({
  last_heartbeat: { type: Date, default: Date.now }
}, { collection: 'heartbeats' });

export const Heartbeat = mongoose.model('Heartbeat', HeartbeatSchema);

const SettingsSchema = new mongoose.Schema({
  ocr_confidence_threshold: { type: Number, default: 0.6 },
  validation_frames: { type: Number, default: 5 },
  cooldown_seconds: { type: Number, default: 60 },
  alert_on_unknown: { type: Boolean, default: true },
  alert_on_frequent: { type: Boolean, default: true }
}, { collection: 'settings' });

export const Settings = mongoose.model('Settings', SettingsSchema);
