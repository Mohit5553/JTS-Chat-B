import { Notification } from "../models/Notification.js";

export const getNotifications = async (req, res) => {
  try {
    const { isRead, type } = req.query;
    const query = { recipient: req.user._id };
    if (isRead === "true") query.isRead = true;
    if (isRead === "false") query.isRead = false;
    if (type) query.type = type;
    const notifications = await Notification.find({ recipient: req.user._id })
      .find(query)
      .sort({ createdAt: -1 })
      .limit(200);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notification = await Notification.findOneAndUpdate(
      { _id: id, recipient: req.user._id },
      { isRead: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.json(notification);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, isRead: false },
      { isRead: true }
    );
    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    await Notification.findOneAndDelete({ _id: id, recipient: req.user._id });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
