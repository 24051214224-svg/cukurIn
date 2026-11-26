const pool = require("../config/database");
const {
  notificationIdSchema,
  notificationListQuerySchema,
} = require("../validators/notificationValidator");

const getNotifications = async (req, res) => {
  const validation = notificationListQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Parameter daftar notifikasi tidak valid",
      errors: validation.error.issues,
    });
  }

  const { limit, offset } = validation.data;
  try {
    const result = await pool.query(
      `SELECT id, title, message, notification_type, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    return res.status(200).json({
      success: true,
      message: "Daftar notifikasi berhasil diambil",
      data: {
        notifications: result.rows,
        pagination: { limit, offset },
      },
    });
  } catch (error) {
    console.error("Get notifications error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar notifikasi",
    });
  }
};

const markNotificationAsRead = async (req, res) => {
  const validation = notificationIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID notifikasi tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING id, title, message, notification_type, is_read, created_at`,
      [validation.data, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Notifikasi tidak ditemukan",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notifikasi ditandai telah dibaca",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Mark notification as read error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal memperbarui notifikasi",
    });
  }
};

module.exports = { getNotifications, markNotificationAsRead };
