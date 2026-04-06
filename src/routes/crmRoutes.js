import { Router } from "express";
import {
  listCustomers,
  getCustomerProfile,
  updateCustomer,
  addCustomerNote,
  sendCustomerEmail,
  createCustomer,
  archiveCustomer,
  deleteCustomer,
  getCustomerActivity,
  createFollowUpTask,
  updateFollowUpTask,
  deleteFollowUpTask,
  mergeCustomers
} from "../controllers/crmController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";
import {
  validate,
  updateCustomerSchema,
  sendCustomerEmailSchema,
  createCustomerSchema,
  createFollowUpTaskSchema,
  updateFollowUpTaskSchema,
  mergeCustomersSchema
} from "../utils/validators.js";
import { upload } from "../utils/multerConfig.js";

const router = Router();

// All CRM routes are protected and require agent/manager access
router.use(requireAuth, requireRole("admin", "client", "agent", "sales"));
router.use(attachTenantSubscription);
router.use(requirePlanFeature("crm"));

router.get("/", listCustomers);
router.post("/", requireRole("admin", "client", "sales"), validate(createCustomerSchema), createCustomer);
router.post("/:id/archive", requireRole("admin", "client", "sales"), archiveCustomer);
router.post("/merge", requireRole("admin", "client", "manager"), validate(mergeCustomersSchema), mergeCustomers);
router.get("/:id", getCustomerProfile);
router.get("/:id/activity", getCustomerActivity);
router.patch("/:id", requireRole("admin", "client", "sales"), validate(updateCustomerSchema), updateCustomer);
router.post("/:id/notes", requireRole("admin", "client", "sales"), addCustomerNote);
router.post("/:id/send-email", requireRole("sales"), upload.single("attachment"), sendCustomerEmail);
router.post("/:id/tasks", requireRole("admin", "client", "sales"), validate(createFollowUpTaskSchema), createFollowUpTask);
router.patch("/:id/tasks/:taskId", requireRole("admin", "client", "sales"), validate(updateFollowUpTaskSchema), updateFollowUpTask);
router.delete("/:id/tasks/:taskId", requireRole("admin", "client", "sales"), deleteFollowUpTask);
router.delete("/:id", requireRole("admin", "client"), deleteCustomer);

export default router;
