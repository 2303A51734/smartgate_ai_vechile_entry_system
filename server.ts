import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import cors from "cors";
import "dotenv/config";
import mongoose from "mongoose";
import apiRoutes from "./routes/api";
import { ocrBridge } from "./lib/ocrBridge";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" }
  });

  const PORT = 3000;
  const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/smartgate";

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(cors());

  // Simple Logger
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/log') {
      console.log(`[API] ${req.method} ${req.path} from ${req.ip}`);
    }
    next();
  });

  // Attach io to request
  app.use((req: any, res, next) => {
    req.io = io;
    next();
  });

  // API Routes
  app.use("/", apiRoutes);

  // Socket Events
  io.on("connection", (socket) => {
    socket.on("ocr_response", (data) => {
      const { requestId, result } = data;
      ocrBridge.emit(`ocr_completed_${requestId}`, result);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Connect to MongoDB
  try {
    let uri = MONGODB_URI.trim();
    
    // Auto-fix common URI mistakes
    if (uri && !uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
      if (uri.includes(".mongodb.net")) {
        uri = `mongodb+srv://${uri}`;
      } else {
        uri = `mongodb://${uri}`;
      }
    }

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("✅ Connected to MongoDB");
  } catch (err: any) {
    const message = err.message || String(err);
    console.error("❌ MongoDB Connection Error:", message);
    
    if (message.includes("auth failed") || message.includes("Authentication failed") || message.includes("bad auth")) {
      console.error("❌ CRITICAL: MongoDB Authentication Failed.");
      console.log("💡 TIP: Your username or password in MONGODB_URI is incorrect.");
      console.log("💡 TIP: Check your MONGODB_URI in the Settings menu (bottom left).");
    } else if (message.includes("IP address is not on the access list")) {
      console.log("💡 TIP: Ensure your IP address is allowlisted in MongoDB Atlas (Network Access -> 0.0.0.0/0).");
    }
    console.log("⚠️  The application will have limited functionality until MongoDB is connected.");
  }

  // ALWAYS start the server, even if DB fails
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    if (mongoose.connection.readyState !== 1) {
      console.log("⚠️  Running WITHOUT active database connection.");
    }
  });
}

startServer();
