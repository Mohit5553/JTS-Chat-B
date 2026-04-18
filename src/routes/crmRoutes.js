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
  mergeCustomers,
  autoAssignCustomer,
  getMyFollowUpTasks,
  getMyCustomerNotes,
  createQuotation,
  getCustomerQuotations,
  updateQuotationStatus,
  approveQuotation,
  denyQuotation,
  sendQuotation,
  createQuotationPayment,
  getCustomerInvoices,
  bulkUpdateCustomers,
  bulkDeleteCustomers,
  promoteVisitor,
  getCrmReports,
  getWonRevenueTimeseries,
  postWin,
  generateLeadCode,
  searchCustomers
} from "../controllers/crmController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";
import { attachOwnedWebsiteIds } from "../middleware/attachOwnedWebsiteIds.js";
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

// All CRM routes require auth + at minimum sales/manager/agent access
router.use(requireAuth, requireRole("admin", "client", "manager", "agent", "sales"));
router.use(attachOwnedWebsiteIds);   // resolves req.ownedWebsiteIds once per request
router.use(attachTenantSubscription);
router.use(requirePlanFeature("crm"));

// List & create
router.get("/", listCustomers);
router.get("/search", searchCustomers);
router.get("/tasks/my", getMyFollowUpTasks);
router.get("/notes/my", getMyCustomerNotes);
router.post("/", requireRole("admin", "client", "manager", "sales"), validate(createCustomerSchema), createCustomer);
router.post("/promote", requireRole("admin", "client", "manager", "agent", "sales"), promoteVisitor);

// Bulk operations (Manager only)
router.patch("/bulk-update", requireRole("admin", "client", "manager"), bulkUpdateCustomers);
router.delete("/bulk-delete", requireRole("admin", "client", "manager"), bulkDeleteCustomers);

// CRM reports (must be defined before "/:id" route)
router.get("/reports", requireRole("admin", "client", "manager"), getCrmReports);
router.get("/reports/won-timeseries", requireRole("admin", "client", "manager"), getWonRevenueTimeseries);

// Single record operations
router.get("/:id", getCustomerProfile);
router.get("/:id/activity", getCustomerActivity);
router.patch("/:id", requireRole("admin", "client", "manager", "sales"), validate(updateCustomerSchema), updateCustomer);

// Notes (sales can add notes to their own leads)
router.post("/:id/notes", requireRole("admin", "client", "manager", "sales"), addCustomerNote);

// Archive (manager + owner roles only; sales cannot archive)
router.post("/:id/archive", requireRole("admin", "client", "manager"), archiveCustomer);

// Delete (manager + owner; sales cannot delete)
router.delete("/:id", requireRole("admin", "client", "manager"), deleteCustomer);

// Post-win workflow: convert record to won/customer, create onboarding tasks, draft quotation, notify
router.post("/:id/post-win", requireRole("admin", "client", "manager", "sales"), postWin);
router.post("/:id/generate-code", requireRole("admin", "client", "manager", "sales"), generateLeadCode);

// Auto-assign (manager + owner only)
router.post("/:id/auto-assign", requireRole("admin", "client", "manager"), autoAssignCustomer);

// Email (sales + manager)
router.post("/:id/send-email", requireRole("admin", "client", "manager", "sales"), upload.single("attachment"), sendCustomerEmail);

// Merge (manager + owner)
router.post("/merge", requireRole("admin", "client", "manager"), validate(mergeCustomersSchema), mergeCustomers);

// Follow-up tasks (all CRM roles)
router.post("/:id/tasks", requireRole("admin", "client", "manager", "sales"), validate(createFollowUpTaskSchema), createFollowUpTask);
router.patch("/:id/tasks/:taskId", requireRole("admin", "client", "manager", "sales"), validate(updateFollowUpTaskSchema), updateFollowUpTask);
router.delete("/:id/tasks/:taskId", requireRole("admin", "client", "manager", "sales"), deleteFollowUpTask);

// Quotations
router.get("/:customerId/quotations", getCustomerQuotations);
router.get("/:customerId/invoices", requireRole("admin", "client", "manager", "sales"), getCustomerInvoices);
router.post("/quotations", requireRole("admin", "client", "manager", "sales"), createQuotation);
router.patch("/quotations/:id/status", updateQuotationStatus);
router.post("/quotations/:id/send", requireRole("admin", "client", "manager", "sales"), sendQuotation);
router.post("/quotations/:id/pay", requireRole("admin", "client", "manager", "sales"), createQuotationPayment);
router.post("/quotations/:id/approve", requireRole("admin", "client", "manager"), approveQuotation);
router.post("/quotations/:id/deny", requireRole("admin", "client", "manager"), denyQuotation);

export default router;
