const pool = require('../config/db')

// GET /api/users/:userId
exports.getUser = async (req, res) => {
  try {
    const { userId } = req.params
    const result = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.career, u.photo_url, u.is_seller, u.reputation,
              COALESCE(json_agg(pi.url ORDER BY pi.position) FILTER (WHERE pi.url IS NOT NULL), '[]') AS product_images
       FROM users u
       LEFT JOIN products p ON p.seller_id = u.user_id AND p.status = 'active'
       LEFT JOIN product_images pi ON pi.product_id = p.product_id
       WHERE u.user_id = $1
       GROUP BY u.user_id`, [userId]
    )
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' })
    const u = result.rows[0]
    return res.status(200).json({
      userId: u.user_id, name: u.name, email: u.email,
      career: u.career, photoUrl: u.photo_url,
      isSeller: u.is_seller, reputation: parseFloat(u.reputation)
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// PUT /api/users/:userId
exports.updateUser = async (req, res) => {
  try {
    const { userId } = req.params
    if (req.user.userId !== userId) return res.status(403).json({ error: 'No tienes permiso para editar este perfil' })

    const { name, career } = req.body
    if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'El nombre no puede estar vacío' })

    const isProd = process.env.NODE_ENV === 'production'
    const photoUrl = req.file
      ? (isProd
        ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
        : `/uploads/${req.file.filename}`)
      : (req.body.photoUrl || undefined)

    const fields = []
    const values = []
    let idx = 1

    if (name)     { fields.push(`name = $${idx++}`);      values.push(name.trim()) }
    if (career !== undefined) { fields.push(`career = $${idx++}`); values.push(career || null) }
    if (photoUrl) { fields.push(`photo_url = $${idx++}`); values.push(photoUrl) }

    if (!fields.length) return res.status(400).json({ error: 'No hay campos para actualizar' })

    values.push(userId)
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING user_id, name, email, career, photo_url, is_seller, reputation`,
      values
    )
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' })
    const u = result.rows[0]
    return res.status(200).json({ userId: u.user_id, name: u.name, email: u.email, career: u.career, photoUrl: u.photo_url, isSeller: u.is_seller, reputation: parseFloat(u.reputation) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}
