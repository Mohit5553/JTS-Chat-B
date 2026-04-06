import { Router } from "express";
import { uploadAttachment, initVisitorSession, submitSessionFeedback, getWidgetConfig } from "../controllers/chatController.js";
import { getWidgetScript } from "../controllers/widgetController.js";
import { requireWebsiteApiKey } from "../middleware/apiKey.js";
import { upload } from "../utils/multerConfig.js";

const router = Router();

router.get("/chat-widget.js", getWidgetScript);
router.get("/api/widget/config", requireWebsiteApiKey, getWidgetConfig);
router.post("/api/widget/init", requireWebsiteApiKey, initVisitorSession);
router.post("/api/widget/feedback", requireWebsiteApiKey, submitSessionFeedback);
router.post("/api/widget/upload", requireWebsiteApiKey, upload.single("attachment"), uploadAttachment);

export default router;
