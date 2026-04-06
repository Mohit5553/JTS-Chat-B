import { Category } from "../models/Category.js";
import { Website } from "../models/Website.js";

export const getCategories = async (req, res) => {
  try {
    const { websiteId } = req.query;
    const filter = {};

    if (websiteId) {
      // Security: Verify website belongs to manager (if role is client)
      const website = await Website.findById(websiteId);
      if (!website) return res.status(404).json({ message: "Website not found" });

      if (req.user.role === "client" && website.managerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied: Unauthorized website access" });
      }
      
      filter.websiteId = websiteId;
    } else if (req.user.role === "client") {
      filter.managerId = req.user._id;
    } else if (req.user.role === "admin") {
      // Admins see everything if no websiteId provided, but usually they filter by website
    } else {
      // Agents MUST provide a websiteId via query
      return res.status(400).json({ message: "Specific website context is required for categorization." });
    }

    const categories = await Category.find(filter).sort({ name: 1 });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCategory = async (req, res) => {
  try {
    const { name, subcategories, websiteId, department } = req.body;
    
    // Verify website ownership
    const website = await Website.findById(websiteId);
    if (!website || (req.user.role === "client" && website.managerId.toString() !== req.user._id.toString())) {
      return res.status(403).json({ message: "Access denied" });
    }

    const category = new Category({
      department: String(department || "general").trim().toLowerCase(),
      name,
      subcategories: subcategories || [],
      websiteId,
      managerId: website.managerId
    });

    await category.save();
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subcategories, department } = req.body;

    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ message: "Category not found" });

    // Verify ownership
    if (req.user.role === "client" && category.managerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (department) category.department = String(department).trim().toLowerCase();
    if (name) category.name = name;
    if (subcategories) category.subcategories = subcategories;

    await category.save();
    res.json(category);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ message: "Category not found" });

    // Verify ownership
    if (req.user.role === "client" && category.managerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    await Category.findByIdAndDelete(id);
    res.json({ message: "Category deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
