import { Router } from "express";
import { uploadAttachment, acceptChatSession, closeChatSession, getSessionMessages, listAgentSessions, listManagerSessions, listQueuedSessions } from "../controllers/chatController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../utils/multerConfig.js";

const router = Router();

router.get("/admin/sessions", requireAuth, requireRole("admin"), listManagerSessions);
router.get("/client/sessions", requireAuth, requireRole("admin", "client"), listManagerSessions);
router.get("/agent/sessions", requireAuth, requireRole("agent"), listAgentSessions);
router.get("/sessions", requireAuth, async (req, res) => {
  const role = req.user.role;
  if (role === "admin" || role === "client" || role === "manager") return listManagerSessions(req, res);
  return listAgentSessions(req, res);
});
router.get("/queued", requireAuth, listQueuedSessions);
router.get("/sessions/:sessionId/messages", requireAuth, getSessionMessages);
router.patch("/sessions/:sessionId/accept", requireAuth, requireRole("admin", "client", "agent"), acceptChatSession);
router.patch("/sessions/:sessionId/close", requireAuth, closeChatSession);
router.post("/upload", requireAuth, upload.single("attachment"), uploadAttachment);

export default router;


