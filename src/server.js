// import http from "http";
// import { createApp } from "./app.js";
// import { env } from "./config/env.js";
// import { connectDatabase } from "./config/database.js";
// import { createSocketServer } from "./sockets/index.js";

// async function bootstrap() {
//   await connectDatabase();
//   const app = createApp();

//   const server = http.createServer(app);
//   createSocketServer(server);

//   server.on("error", (error) => {
//     if (error.code === "EADDRINUSE") {
//       console.error(`Port ${env.port} is already in use. Stop the existing process or change PORT in .env.`);
//       process.exit(1);
//     }
//     throw error;
//   });

//   server.listen(env.port, () => {
//     console.log(`Server listening on http://localhost:${env.port}`);
//   });
// }

// bootstrap().catch((error) => {
//   console.error("Failed to start server", error);
//   process.exit(1);
// });


import http from "http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { createSocketServer } from "./sockets/index.js";

async function bootstrap() {
  try {
    // ✅ Connect Database
    await connectDatabase();
    console.log("✅ Database connected");

    // ✅ Create Express App
    const app = createApp();

    // ✅ Create HTTP Server
    const server = http.createServer(app);

    // ✅ Initialize Socket.IO
    createSocketServer(server);
    console.log("✅ Socket server initialized");

    // ✅ Handle Server Errors
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`❌ Port ${env.port} is already in use`);
        process.exit(1);
      }
      console.error("❌ Server error:", error);
      throw error;
    });

    // ✅ Start Server
    server.listen(env.port, () => {
      console.log(`🚀 Server running on port ${env.port}`);
    });

  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

bootstrap();