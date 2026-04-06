import { Router } from "express";
import {
  uploadAttachment, acceptChatSession, closeChatSession,
  getSessionMessages, listAgentSessions, listManagerSessions, listSalesSessions,
  listQueuedSessions, getChatHistory, transferChatSession,
  addInternalNote, getInternalNotes, getSessionActivity
} from "../controllers/chatController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../utils/multerConfig.js";

const router = Router();

router.get("/admin/sessions", requireAuth, requireRole("admin"), listManagerSessions);
router.get("/client/sessions", requireAuth, requireRole("admin", "client"), listManagerSessions);
router.get("/agent/sessions", requireAuth, requireRole("agent", "sales", "user"), listAgentSessions);
router.get("/sessions", requireAuth, async (req, res) => {
  const role = req.user.role;
  if (role === "admin" || role === "client" || role === "manager") return listManagerSessions(req, res);
  if (role === "sales") return listSalesSessions(req, res);
  return listAgentSessions(req, res);
});
router.get("/queued", requireAuth, requireRole("admin", "client"), listQueuedSessions);
router.get("/history", requireAuth, requireRole("admin", "client", "manager"), getChatHistory);
router.get("/sessions/:sessionId/messages", requireAuth, getSessionMessages);
router.get("/sessions/:sessionId/activity", requireAuth, getSessionActivity);
router.patch("/sessions/:sessionId/accept", requireAuth, requireRole("admin", "client", "agent", "sales", "user"), acceptChatSession);
router.patch("/sessions/:sessionId/close", requireAuth, closeChatSession);

// Feature 5: Chat Transfer
router.post("/sessions/:sessionId/transfer", requireAuth, requireRole("admin", "client", "agent"), transferChatSession);

// Feature 6: Internal Notes
router.get("/sessions/:sessionId/notes", requireAuth, requireRole("admin", "client", "agent", "sales"), getInternalNotes);
router.post("/sessions/:sessionId/notes", requireAuth, requireRole("admin", "client", "agent", "sales"), addInternalNote);

router.post("/upload", requireAuth, upload.single("attachment"), uploadAttachment);

export default router;
