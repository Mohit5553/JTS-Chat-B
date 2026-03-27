// import { Server } from "socket.io";
// import { ChatSession } from "../models/ChatSession.js";
// import { Message } from "../models/Message.js";
// import { User } from "../models/User.js";
// import { Website } from "../models/Website.js";
// import { addMessage } from "../services/chatService.js";
// import { findAvailableAgent } from "../services/assignmentService.js";
// import { matchesWebsiteDomain } from "../utils/domain.js";

// const OWNER_ROLES = ["admin", "client", "manager"];

// function normalizeRole(role) {
//   return role === "manager" ? "admin" : role;
// }

// export function createSocketServer(httpServer) {
//   const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
//     .split(",")
//     .map(o => o.trim().replace(/\/$/, ""));

//   const io = new Server(httpServer, {
//     cors: {
//       origin: (origin, callback) => {
//         if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) return callback(null, true);
//         callback(new Error(`Socket CORS blocked: ${origin}`));
//       },
//       methods: ["GET", "POST"],
//       credentials: true
//     }
//   });

//   io.use(async (socket, next) => {
//     try {
//       const auth = socket.handshake.auth || {};
//       const userId = auth.userId || auth.id;
//       console.log(`[Socket] Handshake attempt: type=${auth.type}, userId=${userId}, apiKey=${auth.apiKey}`);

//       if (auth.type === "visitor") {
//         const website = await Website.findOne({ apiKey: auth.apiKey });
//         if (!website) {
//           console.error("[Socket] No website found for API key:", auth.apiKey);
//           return next(new Error("Invalid API key"));
//         }
//         // ...
//         socket.data.type = "visitor";
//         socket.data.website = website;
//         socket.data.visitorId = auth.visitorId;
//         socket.data.sessionId = auth.sessionId;
//         return next();
//       }

//       if (auth.type === "agent" && userId) {
//         const user = await User.findById(userId);
//         if (!user) {
//           console.error("[Socket] User not found during handshake:", userId);
//           return next(new Error("User not found"));
//         }
//         // ...
//         const role = normalizeRole(user.role);
//         socket.data.type = role === "agent" ? "agent" : "owner";
//         socket.data.user = user;
//         if (["admin", "client"].includes(role)) {
//           const websiteFilter = role === "admin" ? {} : { managerId: user._id };
//           const websites = await Website.find(websiteFilter).select("_id");
//           socket.data.websiteIds = websites.map((website) => website._id.toString());
//         }
//         return next();
//       }

//       console.error("[Socket] Unauthorized connection attempt:", auth);
//       return next(new Error("Unauthorized socket connection"));
//     } catch (error) {
//       console.error("[Socket] Auth error:", error);
//       return next(error);
//     }
//   });

//   io.on("connection", async (socket) => {
//     if (socket.data.type === "visitor") {
//       const website = socket.data.website;
//       socket.join(`website_${website._id}`);

//       if (socket.data.sessionId) {
//         socket.join(`session_${socket.data.sessionId}`);
//       }
//     }

//     if (socket.data.type === "agent" || socket.data.type === "owner") {
//       const user = socket.data.user;
//       const role = normalizeRole(user.role);
//       socket.join(`user_${user._id}`);

//       if (socket.data.type === "owner") {
//         socket.join(role === "admin" ? "owner_admin" : `owner_${user._id}`);
//         for (const websiteId of socket.data.websiteIds || []) {
//           socket.join(`website_${websiteId}`);
//         }
//       }

//       user.isOnline = true;
//       user.lastActiveAt = new Date();
//       await user.save();
//     }

//     socket.on("agent:join-session", ({ sessionId }) => {
//       socket.join(`session_${sessionId}`);
//     });

//     socket.on("visitor:typing", ({ sessionId, isTyping }) => {
//       socket.to(`session_${sessionId}`).emit("chat:typing", { isTyping, sender: "visitor" });
//     });

//     socket.on("agent:typing", ({ sessionId, isTyping }) => {
//       socket.to(`session_${sessionId}`).emit("chat:typing", { isTyping, sender: "agent" });
//     });

//     socket.on("visitor:message", async ({ sessionId, message, attachmentUrl = null, attachmentType = null }) => {
//       const session = await ChatSession.findOne({ sessionId })
//         .populate("assignedAgent")
//         .populate("visitorId")
//         .populate("websiteId", "managerId websiteName domain");
//       if (!session || (!message?.trim() && !attachmentUrl)) {
//         return;
//       }

//       if (!session.assignedAgent) {
//         const agent = await findAvailableAgent(session.websiteId.managerId);
//         if (agent) {
//           session.assignedAgent = agent._id;
//           session.status = "active";
//           session.acceptedAt = session.acceptedAt || new Date();
//           await session.save();
//           io.to(`user_${agent._id}`).emit("chat:assigned", { sessionId: session.sessionId });
//         } else {
//           session.status = "queued";
//           await session.save();
//         }
//       }

//       const saved = await addMessage({ chatSession: session, sender: "visitor", message: message || "", attachmentUrl, attachmentType });

//       const payload = {
//         _id: saved._id,
//         sessionId: session.sessionId,
//         message: saved.message,
//         attachmentUrl: saved.attachmentUrl,
//         attachmentType: saved.attachmentType,
//         sender: "visitor",
//         senderName: session.visitorId?.name || "You",
//         createdAt: saved.createdAt,
//         assignedAgent: session.assignedAgent?._id || session.assignedAgent || null,
//         websiteId: session.websiteId._id,
//         needsAttention: session.status === "queued"
//       };

//       io.to(`session_${session.sessionId}`).emit("chat:message", payload);
//       io.to(`website_${session.websiteId._id}`).emit("chat:new-message", payload);
//       io.to(`owner_${session.websiteId.managerId}`).emit("chat:new-message", payload);
//       io.to("owner_admin").emit("chat:new-message", payload);
//       if (session.assignedAgent) {
//         io.to(`user_${session.assignedAgent._id || session.assignedAgent}`).emit("chat:new-message", payload);
//       }
//     });

//     socket.on("agent:message", async ({ sessionId, message, attachmentUrl = null, attachmentType = null }) => {
//       const user = socket.data.user;
//       const role = normalizeRole(user.role);
//       const session = await ChatSession.findOne({ sessionId }).populate("websiteId", "managerId");
//       if (!session || (!message?.trim() && !attachmentUrl)) {
//         return;
//       }

//       if (socket.data.type === "owner" && role === "client" && session.websiteId.managerId.toString() !== user._id.toString()) {
//         return;
//       }

//       if (!session.assignedAgent) {
//         session.assignedAgent = user._id;
//         session.acceptedAt = new Date();
//       }

//       if (!session.firstResponseAt) {
//         session.firstResponseAt = new Date();
//       }

//       session.status = "active";
//       await session.save();

//       const saved = await addMessage({ chatSession: session, sender: "agent", message: message || "", attachmentUrl, attachmentType, agentId: user._id });

//       const payload = {
//         _id: saved._id,
//         sessionId: session.sessionId,
//         message: saved.message,
//         attachmentUrl: saved.attachmentUrl,
//         attachmentType: saved.attachmentType,
//         sender: "agent",
//         senderName: user.name || "Support",
//         createdAt: saved.createdAt,
//         agentId: user._id
//       };

//       io.to(`session_${session.sessionId}`).emit("chat:message", payload);
//       io.to(`owner_${session.websiteId.managerId}`).emit("chat:message", payload);
//       io.to("owner_admin").emit("chat:message", payload);
//     });

//     socket.on("agent:close-session", async ({ sessionId }) => {
//       const user = socket.data.user;
//       const session = await ChatSession.findOne({ sessionId }).populate("websiteId", "managerId");
//       if (!session) return;

//       const role = normalizeRole(user.role);
//       if (socket.data.type === "owner" && role === "client" && session.websiteId.managerId.toString() !== user._id.toString()) {
//         return;
//       }

//       session.status = "closed";
//       session.closedAt = new Date();
//       await session.save();

//       io.to(`session_${session.sessionId}`).emit("chat:closed", { sessionId: session.sessionId });
//       io.to(`owner_${session.websiteId.managerId}`).emit("chat:closed", { sessionId: session.sessionId });
//       io.to("owner_admin").emit("chat:closed", { sessionId: session.sessionId });
//     });

//     socket.on("visitor:typing", ({ sessionId, isTyping }) => {
//       socket.to(`session_${sessionId}`).emit("chat:typing", { sessionId, isTyping, sender: "visitor" });
//     });

//     socket.on("agent:typing", ({ sessionId, isTyping }) => {
//       socket.to(`session_${sessionId}`).emit("chat:typing", { sessionId, isTyping, sender: "agent" });
//     });

//     socket.on("chat:history:read", async ({ sessionId }) => {
//       const session = await ChatSession.findOne({ sessionId });
//       if (!session) return;
//       await Message.updateMany({ sessionId: session._id, readAt: null, sender: { $ne: socket.data.type === "visitor" ? "visitor" : "agent" } }, { $set: { readAt: new Date() } });
//       io.to(`session_${sessionId}`).emit("chat:read", { sessionId });
//     });

//     socket.on("disconnect", async () => {
//       if ((socket.data.type === "agent" || socket.data.type === "owner") && socket.data.user) {
//         const user = await User.findById(socket.data.user._id);
//         if (user) {
//           user.isOnline = false;
//           user.lastActiveAt = new Date();
//           await user.save();
//         }
//       }
//     });
//   });

//   return io;
// }


import { Server } from "socket.io";
import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import { addMessage } from "../services/chatService.js";
import { findAvailableAgent } from "../services/assignmentService.js";
import { matchesWebsiteDomain } from "../utils/domain.js";

const OWNER_ROLES = ["admin", "client", "manager"];

function normalizeRole(role) {
  return role === "manager" ? "admin" : role;
}

export function createSocketServer(httpServer) {

  // ✅ ✅ FIXED SOCKET CORS (ALLOW ALL WEBSITES)
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const userId = auth.userId || auth.id;

      console.log(`[Socket] Handshake: type=${auth.type}, userId=${userId}, apiKey=${auth.apiKey}`);

      // VISITOR
      if (auth.type === "visitor") {
        const website = await Website.findOne({ apiKey: auth.apiKey });

        if (!website) {
          console.error("[Socket] Invalid API key:", auth.apiKey);
          return next(new Error("Invalid API key"));
        }

        socket.data.type = "visitor";
        socket.data.website = website;
        socket.data.visitorId = auth.visitorId;
        socket.data.sessionId = auth.sessionId;

        return next();
      }

      // AGENT / OWNER
      if (auth.type === "agent" && userId) {
        const user = await User.findById(userId);

        if (!user) {
          console.error("[Socket] User not found:", userId);
          return next(new Error("User not found"));
        }

        const role = normalizeRole(user.role);

        socket.data.type = role === "agent" ? "agent" : "owner";
        socket.data.user = user;

        if (["admin", "client"].includes(role)) {
          const websiteFilter = role === "admin" ? {} : { managerId: user._id };
          const websites = await Website.find(websiteFilter).select("_id");

          socket.data.websiteIds = websites.map(w => w._id.toString());
        }

        return next();
      }

      console.error("[Socket] Unauthorized:", auth);
      return next(new Error("Unauthorized socket connection"));

    } catch (error) {
      console.error("[Socket] Auth error:", error);
      return next(error);
    }
  });

  io.on("connection", async (socket) => {

    // VISITOR JOIN
    if (socket.data.type === "visitor") {
      const website = socket.data.website;

      socket.join(`website_${website._id}`);

      if (socket.data.sessionId) {
        socket.join(`session_${socket.data.sessionId}`);
      }
    }

    // AGENT / OWNER JOIN
    if (socket.data.type === "agent" || socket.data.type === "owner") {
      const user = socket.data.user;
      const role = normalizeRole(user.role);

      socket.join(`user_${user._id}`);

      if (socket.data.type === "owner") {
        socket.join(role === "admin" ? "owner_admin" : `owner_${user._id}`);

        for (const websiteId of socket.data.websiteIds || []) {
          socket.join(`website_${websiteId}`);
        }
      }

      user.isOnline = true;
      user.lastActiveAt = new Date();
      await user.save();
    }

    // JOIN SESSION
    socket.on("agent:join-session", ({ sessionId }) => {
      socket.join(`session_${sessionId}`);
    });

    // TYPING EVENTS
    socket.on("visitor:typing", ({ sessionId, isTyping }) => {
      socket.to(`session_${sessionId}`).emit("chat:typing", { isTyping, sender: "visitor" });
    });

    socket.on("agent:typing", ({ sessionId, isTyping }) => {
      socket.to(`session_${sessionId}`).emit("chat:typing", { isTyping, sender: "agent" });
    });

    // VISITOR MESSAGE
    socket.on("visitor:message", async ({ sessionId, message, attachmentUrl = null, attachmentType = null }) => {
      const session = await ChatSession.findOne({ sessionId })
        .populate("assignedAgent")
        .populate("visitorId")
        .populate("websiteId", "managerId websiteName domain");

      if (!session || (!message?.trim() && !attachmentUrl)) return;

      if (!session.assignedAgent) {
        const agent = await findAvailableAgent(session.websiteId.managerId);

        if (agent) {
          session.assignedAgent = agent._id;
          session.status = "active";
          session.acceptedAt = session.acceptedAt || new Date();
          await session.save();

          io.to(`user_${agent._id}`).emit("chat:assigned", { sessionId: session.sessionId });
        } else {
          session.status = "queued";
          await session.save();
        }
      }

      const saved = await addMessage({
        chatSession: session,
        sender: "visitor",
        message: message || "",
        attachmentUrl,
        attachmentType
      });

      const payload = {
        _id: saved._id,
        sessionId: session.sessionId,
        message: saved.message,
        attachmentUrl: saved.attachmentUrl,
        attachmentType: saved.attachmentType,
        sender: "visitor",
        senderName: session.visitorId?.name || "You",
        createdAt: saved.createdAt,
        assignedAgent: session.assignedAgent?._id || session.assignedAgent || null,
        websiteId: session.websiteId._id,
        needsAttention: session.status === "queued"
      };

      io.to(`session_${session.sessionId}`).emit("chat:message", payload);
      io.to(`website_${session.websiteId._id}`).emit("chat:new-message", payload);
      io.to(`owner_${session.websiteId.managerId}`).emit("chat:new-message", payload);
      io.to("owner_admin").emit("chat:new-message", payload);

      if (session.assignedAgent) {
        io.to(`user_${session.assignedAgent._id || session.assignedAgent}`).emit("chat:new-message", payload);
      }
    });

    // AGENT MESSAGE
    socket.on("agent:message", async ({ sessionId, message, attachmentUrl = null, attachmentType = null }) => {
      const user = socket.data.user;
      const role = normalizeRole(user.role);

      const session = await ChatSession.findOne({ sessionId }).populate("websiteId", "managerId");
      if (!session || (!message?.trim() && !attachmentUrl)) return;

      if (socket.data.type === "owner" && role === "client" &&
        session.websiteId.managerId.toString() !== user._id.toString()) {
        return;
      }

      if (!session.assignedAgent) {
        session.assignedAgent = user._id;
        session.acceptedAt = new Date();
      }

      if (!session.firstResponseAt) {
        session.firstResponseAt = new Date();
      }

      session.status = "active";
      await session.save();

      const saved = await addMessage({
        chatSession: session,
        sender: "agent",
        message: message || "",
        attachmentUrl,
        attachmentType,
        agentId: user._id
      });

      const payload = {
        _id: saved._id,
        sessionId: session.sessionId,
        message: saved.message,
        attachmentUrl: saved.attachmentUrl,
        attachmentType: saved.attachmentType,
        sender: "agent",
        senderName: user.name || "Support",
        createdAt: saved.createdAt,
        agentId: user._id
      };

      io.to(`session_${session.sessionId}`).emit("chat:message", payload);
      io.to(`owner_${session.websiteId.managerId}`).emit("chat:message", payload);
      io.to("owner_admin").emit("chat:message", payload);
    });

    // CLOSE SESSION
    socket.on("agent:close-session", async ({ sessionId }) => {
      const user = socket.data.user;

      const session = await ChatSession.findOne({ sessionId }).populate("websiteId", "managerId");
      if (!session) return;

      const role = normalizeRole(user.role);

      if (socket.data.type === "owner" && role === "client" &&
        session.websiteId.managerId.toString() !== user._id.toString()) {
        return;
      }

      session.status = "closed";
      session.closedAt = new Date();
      await session.save();

      io.to(`session_${session.sessionId}`).emit("chat:closed", { sessionId });
      io.to(`owner_${session.websiteId.managerId}`).emit("chat:closed", { sessionId });
      io.to("owner_admin").emit("chat:closed", { sessionId });
    });

    // READ STATUS
    socket.on("chat:history:read", async ({ sessionId }) => {
      const session = await ChatSession.findOne({ sessionId });
      if (!session) return;

      await Message.updateMany(
        {
          sessionId: session._id,
          readAt: null,
          sender: { $ne: socket.data.type === "visitor" ? "visitor" : "agent" }
        },
        { $set: { readAt: new Date() } }
      );

      io.to(`session_${sessionId}`).emit("chat:read", { sessionId });
    });

    // DISCONNECT
    socket.on("disconnect", async () => {
      if ((socket.data.type === "agent" || socket.data.type === "owner") && socket.data.user) {
        const user = await User.findById(socket.data.user._id);

        if (user) {
          user.isOnline = false;
          user.lastActiveAt = new Date();
          await user.save();
        }
      }
    });

  });

  return io;
}