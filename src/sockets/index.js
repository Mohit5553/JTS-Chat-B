import { Server } from "socket.io";
import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import { findAvailableAgent } from "../services/assignmentService.js";
import { addMessage } from "../services/chatService.js";
import { Notification } from "../models/Notification.js";
import { normalizeRole } from "../utils/roleUtils.js";
import { createNotification } from "../services/notificationService.js";
import { logAuditEvent } from "../services/auditService.js";
import { dispatchWebsiteWebhook } from "../services/webhookService.js";
import { getUserFromToken } from "../middleware/auth.js";

let ioInstance = null;

function getSessionWebsiteId(session) {
  return session?.websiteId?._id || session?.websiteId || null;
}

function getSessionManagerId(session) {
  return session?.websiteId?.managerId || null;
}

async function hasReachedActiveChatLimit(userId) {
  const maxAllowed = 5;
  const activeCount = await ChatSession.countDocuments({ assignedAgent: userId, status: "active" });
  return activeCount >= maxAllowed;
}

const broadcastStatsUpdate = (io, websiteId, managerId) => {
  if (websiteId) io.to(`ws_${websiteId}`).emit("stats:update");
  if (managerId) io.to(`us_${managerId}`).emit("stats:update");
  io.to("us_admin").emit("stats:update");
};

export function emitSessionUpdate(session) {
  if (!ioInstance || !session) return;
  const websiteId = getSessionWebsiteId(session);
  ioInstance.to(session.sessionId).emit("chat:session-updated", session);
  if (websiteId) {
    ioInstance.to(`ws_${websiteId}`).emit("chat:session-updated", session);
  }
  if (getSessionManagerId(session)) {
    ioInstance.to(`us_${getSessionManagerId(session)}`).emit("chat:session-updated", session);
  }
  if (session.assignedAgent) {
    ioInstance.to(`us_${session.assignedAgent._id || session.assignedAgent}`).emit("chat:session-updated", session);
  }
  ioInstance.to("us_admin").emit("chat:session-updated", session);
}

export function getSocketServer() {
  return ioInstance;
}




// Global utility for creating and emitting notifications
async function createAndEmitNotification(io, { recipient, type, title, message, link }) {
  try {
    const notification = await createNotification({ recipient, type, title, message, link });
    if (!notification) return null;
    io.to(`us_${recipient}`).emit("notification:new", notification);
    return notification;
  } catch (error) {
    console.error("Notification Error:", error);
  }
}

// Automated Queue Processor
async function processQueue(io) {
  try {
    const queuedSessions = await ChatSession.find({ status: "queued" }).sort({ createdAt: 1 });
    for (const session of queuedSessions) {
      const website = await Website.findById(session.websiteId);
      if (!website) continue;

      const agent = await findAvailableAgent({ managerId: website.managerId, websiteId: website._id });
      if (agent) {
        session.assignedAgent = agent._id;
        session.status = "active";
        session.acceptedAt = new Date();
        await session.save();
        emitSessionUpdate(await ChatSession.findById(session._id).populate("websiteId", "websiteName domain managerId").populate("visitorId", "visitorId name email").populate("assignedAgent", "name email role isOnline"));

        io.to(session.sessionId).emit("chat:assigned", { 
          sessionId: session.sessionId,
          agentName: agent.name 
        });
        io.to(`us_${agent._id}`).emit("chat:assigned", { sessionId: session.sessionId });

        await createAndEmitNotification(io, {
          recipient: agent._id,
          type: "new_chat",
          title: "New Assigned Chat",
          message: "A queued visitor has been automatically assigned to you.",
          link: `/admin?tab=chats&sessionId=${session.sessionId}`
        });
        await dispatchWebsiteWebhook(session.websiteId._id || session.websiteId, "chat.assigned", {
          sessionId: session.sessionId,
          assignedAgentId: agent._id,
          assignedAgentName: agent.name
        });
      }
    }
  } catch (err) {
    console.error("Queue Processing Error:", err);
  }
}

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ["polling", "websocket"], // Reverted for maximum stability
    allowEIO3: true
  });
  ioInstance = io;

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};

      if (auth.type === "visitor") {
        const website = await Website.findOne({ apiKey: auth.apiKey });
        if (!website) return next(new Error("Invalid API key"));
        
        socket.data.type = "visitor";
        socket.data.website = website;
        socket.data.visitorId = auth.visitorId;
        socket.data.sessionId = auth.sessionId;
        
        // Find CRN if session already exists
        if (auth.sessionId) {
          const session = await ChatSession.findOne({ sessionId: auth.sessionId });
          if (session && session.crn) {
            socket.data.crn = session.crn;
          }
        }

        if (auth.visitorId) {
          socket.join(`visitor_${auth.visitorId}`);
        }
        return next();
      }

      if (auth.type === "agent" && auth.token) {
        const rawToken = String(auth.token).replace(/^Bearer\s+/i, "");
        const user = await getUserFromToken(rawToken);
        if (!user) return next(new Error("User not found"));
        
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

      return next(new Error("Unauthorized socket connection"));
    } catch (error) {
      return next(error);
    }
  });

  io.on("connection", async (socket) => {
    // 1. Initial Handshake & Monitoring
    if (socket.data.type === "visitor") {
      const { website, sessionId, visitorId } = socket.data;
      socket.join(`ws_${website._id}`);
      if (sessionId) {
        socket.join(sessionId);
        io.to(sessionId).emit("visitor:status", { 
          sessionId, 
          isOnline: true, 
          lastActiveAt: new Date() 
        });
      }
    }

    if (socket.data.type === "agent" || socket.data.type === "owner") {
      const user = socket.data.user;
      socket.join(`us_${user._id}`);
      if (socket.data.type === "owner") {
        const role = normalizeRole(user.role);
        socket.join(role === "admin" ? "us_admin" : `us_${user._id}`);
        for (const websiteId of socket.data.websiteIds || []) {
          socket.join(`ws_${websiteId}`);
        }
      }
      user.isOnline = true;
      user.lastActiveAt = new Date();
      await user.save();
      processQueue(io);
    }

    // 2. Generic Handlers
    socket.on("agent:join-session", ({ sessionId }) => {
      // Leave all rooms that look like session rooms except the socket's own ID room
      // and the target sessionId. We identify session rooms as any room that:
      //   - is not the socket's own id room
      //   - does not start with a well-known non-session prefix (ws_, us_, visitor_)
      //   - is not the target sessionId
      const NON_SESSION_PREFIXES = ["ws_", "us_", "visitor_"];
      for (const room of socket.rooms) {
        if (room === socket.id) continue;  // socket's own room
        if (room === sessionId) continue;  // already in target
        if (NON_SESSION_PREFIXES.some(p => room.startsWith(p))) continue;
        console.log(`[SOCKET_LEAVE]: Agent leaving session room ${room}`);
        socket.leave(room);
      }

      console.log(`[SOCKET_JOIN]: Agent ${socket.data.user?._id} joining room ${sessionId}`);
      socket.join(sessionId);
    });

    socket.on("visitor:join-room", ({ sessionId }) => {
      console.log(`[SOCKET_JOIN]: Visitor joining room ${sessionId}`);
      socket.join(sessionId);
    });

    socket.on("visitor:typing", ({ sessionId, isTyping }) => {
      socket.to(sessionId).emit("chat:typing", { isTyping, sender: "visitor" });
    });

    socket.on("agent:typing", ({ sessionId, isTyping }) => {
      socket.to(sessionId).emit("chat:typing", { isTyping, sender: "agent" });
    });

    socket.on("visitor:message", async ({ sessionId, message, attachmentUrl = null, attachmentType = null, tempId = null }) => {
      try {
        const { website, visitorId } = socket.data;
        if (!website || !visitorId) throw new Error("Visitor context missing in socket data");
        
        console.log(`[VISITOR_STEP 1]: Event received for session ${sessionId}`);
        const session = await ChatSession.findOne({ sessionId })
          .populate("assignedAgent")
          .populate("websiteId");
        
        if (!session || (!message?.trim() && !attachmentUrl)) {
          console.warn(`[VISITOR_STEP 1a]: Session ${sessionId} not found or message empty`);
          return;
        }

        console.log(`[VISITOR_STEP 2]: Session found: ${session._id}`);
        
        // Re-open if closed
        if (session.status === "closed") {
          session.status = "active";
          session.closedAt = null;
          await session.save(); // Persist the change!
          console.log(`[VISITOR_STEP 2b]: Session re-opened and saved for ${session.sessionId}`);
        }

        // Auto-assign if unassigned
        if (!session.assignedAgent) {
          const agent = await findAvailableAgent({ managerId: session.websiteId.managerId, websiteId: session.websiteId._id });
          if (agent && !await hasReachedActiveChatLimit(agent._id)) {
            session.assignedAgent = agent._id;
            session.status = "active";
            session.acceptedAt = new Date();
            await session.save();
            emitSessionUpdate(await ChatSession.findById(session._id).populate("websiteId", "websiteName domain managerId").populate("visitorId", "visitorId name email").populate("assignedAgent", "name email role isOnline"));
            io.to(`us_${agent._id}`).emit("chat:assigned", { sessionId: session.sessionId });
            io.to(session.sessionId).emit("chat:assigned", { sessionId: session.sessionId, agentName: agent.name });
            await createAndEmitNotification(io, {
              recipient: agent._id,
              type: "new_chat",
              title: "New chat assigned",
              message: `Visitor ${session.visitorId?.name || session.sessionId} has been assigned to you.`,
              link: `/client?tab=chats&sessionId=${session.sessionId}`
            });
            await dispatchWebsiteWebhook(session.websiteId._id, "chat.assigned", {
              sessionId: session.sessionId,
              assignedAgentId: agent._id,
              assignedAgentName: agent.name
            });
            console.log(`[VISITOR_STEP 2a]: Auto-assigned to agent ${agent._id}`);
          } else if (session.status !== "queued") {
            session.status = "queued";
            await session.save();
            emitSessionUpdate(await ChatSession.findById(session._id).populate("websiteId", "websiteName domain managerId").populate("visitorId", "visitorId name email").populate("assignedAgent", "name email role isOnline"));
            io.to(session.sessionId).emit("chat:queued", { sessionId: session.sessionId, message: "Agents are busy. You're in queue." });
          }
        }

        console.log(`[VISITOR_STEP 3]: Persistence started for message`);
        const saved = await addMessage({
          chatSession: session,
          sender: "visitor",
          message: message || "",
          attachmentUrl,
          attachmentType
        });

        console.log(`[VISITOR_STEP 4]: Saved to DB: ${saved?._id}`);
        const payload = {
          _id: saved._id,
          sessionId: session.sessionId,
          message: saved.message,
          attachmentUrl: saved.attachmentUrl,
          attachmentType: saved.attachmentType,
          sender: "visitor",
          senderName: "Visitor",
          createdAt: saved.createdAt,
          tempId
        };

        // Emit to session and dashboards
        io.to(session.sessionId).emit("chat:message", payload);
        io.to(`ws_${session.websiteId._id}`).emit("chat:new-message", payload);
        
        broadcastStatsUpdate(io, session.websiteId._id, session.websiteId.managerId);

        // --- QUICK REPLY AUTO-RESPONSE LOGIC ---
        const quickReply = session.websiteId.quickReplies?.find(qr => qr.text === message);
        if (quickReply?.autoResponse) {
          setTimeout(async () => {
            try {
              const autoMsg = await addMessage({
                chatSession: session,
                sender: "agent",
                message: quickReply.autoResponse,
                senderName: session.websiteId.websiteName,
                isAi: true
              });

              const autoPayload = {
                _id: autoMsg._id,
                sessionId: session.sessionId,
                message: autoMsg.message,
                sender: "agent",
                senderName: session.websiteId.websiteName,
                isAi: true,
                createdAt: autoMsg.createdAt
              };

              io.to(session.sessionId).emit("chat:message", autoPayload);
              io.to(`ws_${session.websiteId._id}`).emit("chat:new-message", autoPayload);
              broadcastStatsUpdate(io, session.websiteId._id, session.websiteId.managerId);
            } catch (err) {
              console.error("AutoResponse failed", err);
            }
          }, 1000);
        }
        // ----------------------------------------

        if (session.assignedAgent) {
          io.to(`us_${session.assignedAgent._id || session.assignedAgent}`).emit("chat:message", payload);
        }
        console.log(`[VISITOR_STEP 5]: Broadcast complete for session ${session.sessionId}`);
      } catch (err) {
        console.error("[VISITOR_FATAL]:", err);
      }
    });

    // 4. Messaging Logic (Agent)
    socket.on("agent:message", async ({ sessionId, message, attachmentUrl = null, attachmentType = null, tempId = null }) => {
      try {
        const { user } = socket.data;
        if (!user) {
          console.error("[AGENT_STEP 1a]: Identity lost.");
          return;
        }

        // Only explicitly allowed roles can send live messages
        if (!["agent", "sales", "user"].includes(user.role)) {
          console.error(`[AGENT_STEP 1b]: Unauthorized message attempt by role: ${user.role}`);
          socket.emit("chat:error", { message: "Your role is restricted to observer-only for live chats." });
          return;
        }
        
        console.log(`[AGENT_STEP 1]: Event received for session ${sessionId} by ${user.name}`);
        const session = await ChatSession.findOne({ sessionId })
          .populate("websiteId")
          .populate("visitorId", "visitorId");
        if (!session || (!message?.trim() && !attachmentUrl)) {
          console.warn(`[AGENT_STEP 1b]: Session ${sessionId} not found or message empty`);
          return;
        }

        console.log(`[AGENT_STEP 2]: Session found: ${session._id}`);
        
        // Re-open if closed
        let wasClosed = false;
        if (session.status === "closed") {
          session.status = "active";
          session.closedAt = null;
          wasClosed = true;
          console.log(`[AGENT_STEP 2b]: Session re-opened by agent message for ${session.sessionId}`);
        }

        if (!session.assignedAgent) {
          if (await hasReachedActiveChatLimit(user._id)) {
            socket.emit("chat:error", { message: "You can only handle up to 5 active visitors at a time." });
            return;
          }
          session.assignedAgent = user._id;
          session.acceptedAt = new Date();
        }
        await session.save();
        emitSessionUpdate(await ChatSession.findById(session._id).populate("websiteId", "websiteName domain managerId").populate("visitorId", "visitorId name email").populate("assignedAgent", "name email role isOnline"));

        if (wasClosed) {
           broadcastStatsUpdate(io, session.websiteId._id, session.websiteId.managerId);
        }

        console.log(`[AGENT_STEP 3]: Persistence started for message`);
        const saved = await addMessage({
          chatSession: session,
          sender: "agent",
          message: message || "",
          attachmentUrl,
          attachmentType,
          agentId: user._id
        });

        console.log(`[AGENT_STEP 4]: Saved to DB: ${saved?._id}`);
        const payload = {
          _id: saved._id,
          sessionId: session.sessionId,
          message: saved.message,
          attachmentUrl: saved.attachmentUrl,
          attachmentType: saved.attachmentType,
          sender: "agent",
          senderName: user.name || "Support",
          createdAt: saved.createdAt,
          agentId: user._id,
          tempId
        };

        // Emit to visitor and dashboards
        const targetRoom = session.sessionId;
        const roomClients = io.sockets.adapter.rooms.get(targetRoom);
        console.log(`[AGENT_TRACE]: Broadcasting to ${targetRoom}. Clients in room: ${roomClients ? roomClients.size : 0}`);
        
        socket.emit("chat:message", payload);
        socket.broadcast.to(targetRoom).emit("chat:message", payload);
        io.to(`ws_${session.websiteId._id}`).emit("chat:new-message", payload); // Add to website room too
        io.to(`us_${session.websiteId.managerId}`).emit("chat:new-message", payload);
        io.to("us_admin").emit("chat:new-message", payload);
        
        console.log(`[AGENT_STEP 5]: Broadcast complete for session ${targetRoom}`);
      } catch (err) {
        console.error("[AGENT_FATAL]:", err);
      }
    });

    // 5. Cleanup Handlers
    socket.on("agent:close-session", async ({ sessionId }) => {
      const session = await ChatSession.findOne({ sessionId }).populate("websiteId");
      if (!session) return;
      const websiteId = getSessionWebsiteId(session);
      const managerId = getSessionManagerId(session);
      session.status = "closed";
      session.closedAt = new Date();
      await session.save();
      emitSessionUpdate(await ChatSession.findById(session._id).populate("websiteId", "websiteName domain managerId").populate("visitorId", "visitorId name email").populate("assignedAgent", "name email role isOnline"));
      await logAuditEvent({
        actor: socket.data.user,
        action: "chat.closed",
        entityType: "chat_session",
        entityId: session._id,
        websiteId,
        metadata: { sessionId },
        ipAddress: socket.handshake.address || ""
      });
      if (websiteId) {
        await dispatchWebsiteWebhook(websiteId, "chat.closed", { sessionId, closedBy: socket.data.user?._id });
      }
      io.to(session.sessionId).emit("chat:closed", { sessionId });
      broadcastStatsUpdate(io, websiteId, managerId);
      processQueue(io);
    });

    socket.on("visitor:close-session", async ({ sessionId }) => {
      const session = await ChatSession.findOne({ sessionId }).populate("websiteId");
      if (!session) return;
      const websiteId = getSessionWebsiteId(session);
      const managerId = getSessionManagerId(session);
      session.status = "closed";
      session.closedAt = new Date();
      await session.save();
      emitSessionUpdate(await ChatSession.findById(session._id).populate("websiteId", "websiteName domain managerId").populate("visitorId", "visitorId name email").populate("assignedAgent", "name email role isOnline"));
      if (websiteId) {
        await dispatchWebsiteWebhook(websiteId, "chat.closed", { sessionId, closedBy: "visitor" });
      }
      io.to(session.sessionId).emit("chat:closed", { sessionId });
      broadcastStatsUpdate(io, websiteId, managerId);
      processQueue(io);
    });

    socket.on("disconnect", async () => {
      if (socket.data.type === "visitor" && socket.data.sessionId) {
        io.to(socket.data.sessionId).emit("visitor:status", { 
          sessionId: socket.data.sessionId, 
          isOnline: false, 
          lastActiveAt: new Date() 
        });
      }
      if (socket.data.user) {
        const u = await User.findById(socket.data.user._id);
        if (u) {
          u.isOnline = false;
          u.lastActiveAt = new Date();
          await u.save();
        }
      }
    });
  });

  return io;
}
