const pool = require("../config/database");
const {
  hairstyleRecommendationQuerySchema,
} = require("../validators/hairstyleValidator");

const getRecommendations = async (req, res) => {
  const validation = hairstyleRecommendationQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Kriteria rekomendasi hairstyle tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, hairstyle_name, description, image_url, face_shape, hair_type
       FROM hairstyles
       WHERE is_active = TRUE
         AND face_shape IN ($1, 'all')
         AND hair_type IN ($2, 'all')
       ORDER BY
         (face_shape = $1 AND hair_type = $2) DESC,
         (face_shape = $1) DESC,
         (hair_type = $2) DESC,
         hairstyle_name ASC,
         id ASC`,
      [validation.data.face_shape, validation.data.hair_type]
    );

    return res.status(200).json({
      success: true,
      message: "Rekomendasi hairstyle berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    console.error("Get hairstyle recommendations error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil rekomendasi hairstyle",
    });
  }
};

module.exports = { getRecommendations };
