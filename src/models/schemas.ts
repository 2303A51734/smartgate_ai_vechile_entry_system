import mongoose from 'mongoose';

const FacultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  department: { type: String, required: true },
  designation: { type: String },
  vehicle_number: { type: String, required: true, unique: true }
});

const BusSchema = new mongoose.Schema({
  bus_number: { type: String, required: true },
  driver_name: { type: String, required: true },
  vehicle_number: { type: String, required: true, unique: true }
});

const LogSchema = new mongoose.Schema({
  vehicle_number: { type: String, required: true },
  type: { type: String, required: true },
  owner_name: { type: String, required: true },
  department: { type: String, required: true },
  entry_time: { type: Date, default: Date.now },
  exit_time: { type: Date },
  duration: { type: String },
  image_data: { type: String },
  status: { type: String, default: 'INSIDE' }
});

const AlertSchema = new mongoose.Schema({
  type: { type: String, required: true },
  message: { type: String, required: true },
  vehicle_number: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  is_read: { type: Boolean, default: false }
});

const SettingsSchema = new mongoose.Schema({
  ocr_confidence_threshold: { type: Number, default: 0.6 },
  validation_frames: { type: Number, default: 5 },
  cooldown_seconds: { type: Number, default: 60 },
  alert_on_unknown: { type: Boolean, default: true },
  alert_on_frequent: { type: Boolean, default: true }
});

const CommandSchema = new mongoose.Schema({
  type: { type: String, required: true },
  status: { type: String, default: 'PENDING' },
  payload: { type: mongoose.Schema.Types.Mixed },
  result: { type: String },
  timestamp: { type: Date, default: Date.now }
});

const DebugLogSchema = new mongoose.Schema({
  message: { type: String, required: true },
  level: { type: String, default: 'INFO' },
  timestamp: { type: Date, default: Date.now }
});

const HeartbeatSchema = new mongoose.Schema({
  last_heartbeat: { type: Date, default: Date.now }
});

export const Faculty = mongoose.model('Faculty', FacultySchema);
export const Bus = mongoose.model('Bus', BusSchema);
export const Log = mongoose.model('Log', LogSchema);
export const Alert = mongoose.model('Alert', AlertSchema);
export const Settings = mongoose.model('Settings', SettingsSchema);
export const Command = mongoose.model('Command', CommandSchema);
export const DebugLog = mongoose.model('DebugLog', DebugLogSchema);
export const Heartbeat = mongoose.model('Heartbeat', HeartbeatSchema);
