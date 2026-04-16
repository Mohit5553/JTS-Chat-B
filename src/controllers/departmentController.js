import { Department } from "../models/Department.js";
import { Category } from "../models/Category.js";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";

function normalizeDepartmentName(value) {
  return String(value || "").trim().toLowerCase();
}

async function resolveOwnedWebsite(websiteId, user) {
  const website = await Website.findById(websiteId);
  if (!website) throw new AppError("Website not found", 404);

  if (user.role === "admin") return website;
  const ownerId = user.role === "client" ? user._id : user.managerId;
  if (String(website.managerId) !== String(ownerId)) throw new AppError("Unauthorized access", 403);
  return website;
}

export const listDepartments = asyncHandler(async (req, res) => {
  const { websiteId } = req.query;
  const filter = {};

  if (websiteId) {
    const website = await resolveOwnedWebsite(websiteId, req.user);
    filter.websiteId = websiteId;
  } else if (req.user.role === "client") {
    filter.managerId = req.user._id;
  } else if (req.user.role === "manager") {
    filter.managerId = req.user.managerId;
  }

  const departments = await Department.find(filter).sort({ name: 1 });
  res.json(departments);
});

export const createDepartment = asyncHandler(async (req, res) => {
  const { websiteId, name } = req.body;
  const website = await resolveOwnedWebsite(websiteId, req.user);

  const department = await Department.create({
    websiteId,
    managerId: website.managerId,
    name: normalizeDepartmentName(name),
    isActive: true
  });

  res.status(201).json(department);
});

export const updateDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findById(req.params.id);
  if (!department) throw new AppError("Department not found", 404);

  const website = await resolveOwnedWebsite(department.websiteId, req.user);

  const nextName = normalizeDepartmentName(req.body.name);
  const previousName = department.name;
  if (!nextName) throw new AppError("Department name is required", 400);

  if (nextName !== previousName) {
    department.name = nextName;
    await Promise.all([
      Category.updateMany(
        { websiteId: department.websiteId, department: previousName },
        { $set: { department: nextName } }
      ),
      User.updateMany(
        { websiteIds: department.websiteId, department: previousName },
        { $set: { department: nextName } }
      )
    ]);
  }

  if (req.body.isActive !== undefined) {
    department.isActive = Boolean(req.body.isActive);
  }

  await department.save();
  res.json(department);
});

export const toggleDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findById(req.params.id);
  if (!department) throw new AppError("Department not found", 404);

  const website = await resolveOwnedWebsite(department.websiteId, req.user);

  department.isActive = !department.isActive;
  await department.save();
  res.json(department);
});
