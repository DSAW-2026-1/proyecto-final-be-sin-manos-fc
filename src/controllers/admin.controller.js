const pool = require('../config/db')

async function insertLog(adminId, action, targetId, targetType, reason = null, evidence = null) {
  const res = await pool.query(
    `INSERT INTO admin_logs (admin_id, action, target_id, target_type, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING log_id`,
    [adminId, action, targetId, targetType, reason, evidence]
  )
  return res.rows[0].log_id
}

// GET /api/admin/dashboard
exports.dashboard = async (req, res) => {
  try {
    const [users, products, reports, orders] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users WHERE is_suspended = false"),
      pool.query("SELECT COUNT(*) FROM products WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) FROM reports WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM orders"),
    ])
    return res.status(200).json({
      totalUsers: parseInt(users.rows[0].count),
      activeProducts: parseInt(products.rows[0].count),
      pendingReports: parseInt(reports.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[admin.dashboard]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// DELETE /api/admin/products/:productId
exports.deleteProduct = async (req, res) => {
  try {
    const { productId } = req.params
    const prod = await pool.query('SELECT product_id FROM products WHERE product_id = $1', [productId])
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' })

    await pool.query("UPDATE products SET status = 'deleted' WHERE product_id = $1", [productId])
    const actionLogId = await insertLog(req.user.userId, 'delete_product', productId, 'product')

    return res.status(200).json({ productId, deleted: true, actionLogId })
  } catch (err) {
    console.error('[admin.deleteProduct]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// PATCH /api/admin/users/:userId/suspend
exports.suspendUser = async (req, res) => {
  try {
    const { userId } = req.params
    const { action, reason, evidence, duration, durationUnit } = req.body

    if (!['suspend', 'delete'].includes(action)) {
      return res.status(400).json({ error: "action debe ser 'suspend' o 'delete'" })
    }

    const userRes = await pool.query('SELECT user_id FROM users WHERE user_id = $1', [userId])
    if (!userRes.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' })

    if (action === 'delete') {
      const actionLogId = await insertLog(req.user.userId, 'delete_user', userId, 'user', reason, evidence)
      await pool.query('DELETE FROM users WHERE user_id = $1', [userId])
      return res.status(200).json({ userId, action: 'delete', actionLogId })
    }

    // action === 'suspend'
    let suspendedUntil = null
    if (duration && durationUnit) {
      const ms = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[durationUnit]
      if (!ms) return res.status(400).json({ error: "durationUnit debe ser 'minutes', 'hours' o 'days'" })
      suspendedUntil = new Date(Date.now() + Number(duration) * ms)
    }

    await pool.query(
      `UPDATE users
       SET is_suspended = true, suspended_until = $1, suspension_reason = $2, suspension_evidence = $3
       WHERE user_id = $4`,
      [suspendedUntil, reason || null, evidence || null, userId]
    )
    const actionLogId = await insertLog(req.user.userId, 'suspend_user', userId, 'user', reason, evidence)

    return res.status(200).json({ userId, action: 'suspend', suspendedUntil, actionLogId })
  } catch (err) {
    console.error('[admin.suspendUser]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// DELETE /api/admin/users/:userId
exports.deleteUser = async (req, res) => {
  try {
    const { userId } = req.params
    const { reason, evidence } = req.body
    const userRes = await pool.query('SELECT user_id FROM users WHERE user_id = $1', [userId])
    if (!userRes.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' })
    const actionLogId = await insertLog(req.user.userId, 'delete_user', userId, 'user', reason, evidence)
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId])
    await pool.query('DELETE FROM cart_items WHERE cart_id IN (SELECT cart_id FROM carts WHERE user_id = $1)', [userId])
    await pool.query('DELETE FROM carts WHERE user_id = $1', [userId])
    await pool.query('DELETE FROM messages WHERE sender_id = $1', [userId])
    await pool.query('DELETE FROM orders WHERE buyer_id = $1 OR seller_id = $1', [userId])
    await pool.query('DELETE FROM products WHERE seller_id = $1', [userId])
    await pool.query('DELETE FROM reviews WHERE buyer_id = $1 OR seller_id = $1', [userId])
    await pool.query('DELETE FROM conversations WHERE buyer_id = $1 OR seller_id = $1', [userId])
    await pool.query('DELETE FROM reports WHERE reporter_id = $1', [userId])
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId])
    return res.status(200).json({ userId, deleted: true, actionLogId })
  } catch (err) {
    console.error('[admin.deleteUser]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/admin/users
exports.listUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.role, u.is_seller, u.is_suspended, u.created_at,
              (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.user_id AND p.status != 'deleted') AS total_products
       FROM users u
       ORDER BY u.created_at DESC`
    )
    return res.status(200).json(result.rows.map(u => ({
      userId: u.user_id,
      name: u.name,
      email: u.email,
      role: u.role,
      isSeller: u.is_seller,
      isSuspended: u.is_suspended,
      createdAt: u.created_at,
      totalProducts: parseInt(u.total_products),
    })))
  } catch (err) {
    console.error('[admin.listUsers]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/admin/products
exports.listProducts = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.product_id, p.title, p.price, p.status, p.stock, p.created_at,
              u.name AS seller_name,
              (SELECT url FROM product_images WHERE product_id = p.product_id ORDER BY position LIMIT 1) AS image_url
       FROM products p
       JOIN users u ON u.user_id = p.seller_id
       WHERE p.status != 'deleted'
       ORDER BY p.created_at DESC`
    )
    return res.status(200).json(result.rows.map(p => ({
      productId: p.product_id, title: p.title, price: parseFloat(p.price),
      status: p.status, stock: p.stock, sellerName: p.seller_name,
      imageUrl: p.image_url, createdAt: p.created_at
    })))
  } catch (err) {
    console.error('[admin.listProducts]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/admin/reports
exports.listReports = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.report_id, u.name AS reporter_name, r.target_id, r.target_type,
              r.reason, r.description, r.status, r.created_at,
              CASE WHEN r.target_type = 'product' THEN p.title
                   WHEN r.target_type = 'user' THEN u2.name
              END AS target_title
       FROM reports r
       JOIN users u ON u.user_id = r.reporter_id
       LEFT JOIN products p ON p.product_id = r.target_id::uuid
       LEFT JOIN users u2 ON u2.user_id = r.target_id::uuid
       ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC`
    )
    return res.status(200).json(result.rows.map(r => ({
      reportId: r.report_id,
      reporterName: r.reporter_name,
      targetId: r.target_id,
      targetType: r.target_type,
      targetTitle: r.target_title,
      reason: r.reason,
      description: r.description,
      status: r.status,
      createdAt: r.created_at,
    })))
  } catch (err) {
    console.error('[admin.listReports]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// PATCH /api/admin/reports/:reportId
exports.updateReport = async (req, res) => {
  try {
    const { reportId } = req.params
    const { status } = req.body
    const validStatuses = ['reviewed', 'actioned', 'dismissed']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status debe ser uno de: ${validStatuses.join(', ')}` })
    }

    const report = await pool.query('SELECT report_id FROM reports WHERE report_id = $1', [reportId])
    if (!report.rows.length) return res.status(404).json({ error: 'Reporte no encontrado' })

    await pool.query(
      'UPDATE reports SET status = $1, reviewed_by = $2 WHERE report_id = $3',
      [status, req.user.userId, reportId]
    )
    return res.status(200).json({ reportId, status })
  } catch (err) {
    console.error('[admin.updateReport]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}
