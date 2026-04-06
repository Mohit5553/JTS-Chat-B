import { Department } from "../models/Department.js";
import { Category } from "../models/Category.js";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";

function normalizeDepartmentName(value) {
  return String(value || "").trim().toLowerCase();
}

async function resolveOwnedWebsite(websiteId, user) {
  const website = await Website.findById(websiteId);
  if (!website) return null;

  if (user.role === "admin") return website;
  const ownerId = user.role === "client" ? user._id : user.managerId;
  if (String(website.managerId) !== String(ownerId)) return null;
  return website;
}

export const listDepartments = async (req, res) => {
  try {
    const { websiteId } = req.query;
    const filter = {};

    if (websiteId) {
      const website = await resolveOwnedWebsite(websiteId, req.user);
      if (!website) return res.status(403).json({ message: "Access denied" });
      filter.websiteId = websiteId;
    } else if (req.user.role === "client") {
      filter.managerId = req.user._id;
    } else if (req.user.role === "manager") {
      filter.managerId = req.user.managerId;
    }

    const departments = await Department.find(filter).sort({ name: 1 });
    res.json(departments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createDepartment = async (req, res) => {
  try {
    const { websiteId, name } = req.body;
    const website = await resolveOwnedWebsite(websiteId, req.user);
    if (!website) return res.status(403).json({ message: "Access denied" });

    const department = await Department.create({
      websiteId,
      managerId: website.managerId,
      name: normalizeDepartmentName(name),
      isActive: true
    });

    res.status(201).json(department);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateDepartment = async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) return res.status(404).json({ message: "Department not found" });

    const website = await resolveOwnedWebsite(department.websiteId, req.user);
    if (!website) return res.status(403).json({ message: "Access denied" });

    const nextName = normalizeDepartmentName(req.body.name);
    const previousName = department.name;
    if (!nextName) return res.status(400).json({ message: "Department name is required" });

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
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const toggleDepartment = async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) return res.status(404).json({ message: "Department not found" });

    const website = await resolveOwnedWebsite(department.websiteId, req.user);
    if (!website) return res.status(403).json({ message: "Access denied" });

    department.isActive = !department.isActive;
    await department.save();
    res.json(department);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
