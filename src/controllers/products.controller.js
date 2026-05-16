const pool = require('../config/db')
const { createNotification } = require('../helpers/notify')

const resolveImageUrl = (url) => {
  if (!url) return null
  if (url.startsWith('data:') || url.startsWith('http')) return url
  return `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:4000'}${url}`
}

// Middleware activateSellerRole — efecto secundario de POST /api/products
async function activateSellerRole(userId) {
  await pool.query(
    'UPDATE users SET is_seller = TRUE WHERE user_id = $1 AND is_seller = FALSE',
    [userId]
  )
}

// POST /api/products
exports.create = async (req, res) => {
  try {
    const { title, description, price, categoryId, condition, stock } = req.body
    const sellerId = req.user.userId
    const details = []

    if (!title || !description || !price || !categoryId || !condition) details.push('Todos los campos son obligatorios')
    if (price <= 0) details.push('price debe ser positivo')
    if (!['new', 'used'].includes(condition)) details.push("condition debe ser 'new' o 'used'")
    if (details.length) return res.status(400).json({ error: 'Datos inválidos', details })

    // Verificar categoría
    const cat = await pool.query('SELECT category_id FROM categories WHERE category_id = $1', [categoryId])
    if (!cat.rows.length) return res.status(400).json({ error: 'Datos inválidos', details: ['categoryId no existe'] })

    // Insertar producto
    const prod = await pool.query(
      `INSERT INTO products (seller_id, category_id, title, description, price, condition, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [sellerId, categoryId, title.trim(), description.trim(), price, condition, stock != null ? parseInt(stock) : 1]
    )
    const product = prod.rows[0]

    // Insertar imágenes si las hay
    const files = req.files || []
    if (files.length > 5) return res.status(400).json({ error: 'Máximo 5 imágenes por producto' })
    const isProd = process.env.NODE_ENV === 'production'
    for (let i = 0; i < files.length; i++) {
      const url = isProd
        ? `data:${files[i].mimetype};base64,${files[i].buffer.toString('base64')}`
        : `/uploads/${files[i].filename}`
      await pool.query(
        'INSERT INTO product_images (product_id, url, position) VALUES ($1,$2,$3)',
        [product.product_id, url, i]
      )
    }

    // Activar rol vendedor (idempotente)
    await activateSellerRole(sellerId)

    return res.status(201).json({
      productId: product.product_id, title: product.title,
      sellerId, status: product.status, stock: product.stock,
      createdAt: product.created_at, sellerActivated: true
    })
  } catch (err) {
    console.error('[products.create]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/products — listado con filtros
exports.list = async (req, res) => {
  try {
    let { page = 1, limit = 20, search, categoryId, condition, minPrice, maxPrice, sellerId } = req.query
    page = parseInt(page); limit = Math.min(parseInt(limit), 20)
    if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice))
      return res.status(400).json({ error: 'minPrice no puede ser mayor que maxPrice' })

    const conditions = ["p.status = 'active'"]
    const values = []
    let idx = 1

    if (search)     { conditions.push(`(p.title ILIKE $${idx} OR p.description ILIKE $${idx})`); values.push(`%${search}%`); idx++ }
    if (categoryId) { conditions.push(`p.category_id = $${idx++}`); values.push(categoryId) }
    if (condition)  { conditions.push(`p.condition = $${idx++}`); values.push(condition) }
    if (minPrice)   { conditions.push(`p.price >= $${idx++}`); values.push(minPrice) }
    if (maxPrice)   { conditions.push(`p.price <= $${idx++}`); values.push(maxPrice) }
    if (sellerId)   { conditions.push(`p.seller_id = $${idx++}`); values.push(sellerId) }

    const where = 'WHERE ' + conditions.join(' AND ')
    const countRes = await pool.query(`SELECT COUNT(*) FROM products p ${where}`, values)
    const total = parseInt(countRes.rows[0].count)
    const offset = (page - 1) * limit

    values.push(limit); values.push(offset)
    const result = await pool.query(
      `SELECT p.product_id, p.title, p.description, p.price, p.condition, p.status, p.stock,
              p.created_at, c.name AS category, u.name AS seller_name, u.user_id AS seller_id,
              (SELECT url FROM product_images WHERE product_id = p.product_id ORDER BY position LIMIT 1) AS image_url
       FROM products p
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN users u ON u.user_id = p.seller_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      values
    )

    return res.status(200).json({
      data: result.rows.map(p => ({
        productId: p.product_id, title: p.title, description: p.description,
        price: parseFloat(p.price), condition: p.condition, category: p.category,
        stock: p.stock, imageUrl: resolveImageUrl(p.image_url),
        sellerName: p.seller_name, sellerId: p.seller_id, createdAt: p.created_at
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (err) {
    console.error('[products.list]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/products/:productId
exports.getOne = async (req, res) => {
  try {
    const { productId } = req.params
    const result = await pool.query(
      `SELECT p.*, c.name AS category, u.name AS seller_name, u.reputation AS seller_rep,
              u.photo_url AS seller_photo
       FROM products p
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN users u ON u.user_id = p.seller_id
       WHERE p.product_id = $1 AND p.status != 'deleted'`, [productId]
    )
    if (!result.rows.length) return res.status(404).json({ error: 'Producto no encontrado' })

    const imgs = await pool.query(
      'SELECT url FROM product_images WHERE product_id = $1 ORDER BY position', [productId]
    )
    const p = result.rows[0]
    return res.status(200).json({
      productId: p.product_id, title: p.title, description: p.description,
      price: parseFloat(p.price), condition: p.condition, status: p.status,
      stock: p.stock, category: p.category, createdAt: p.created_at,
      images: imgs.rows.map(i => resolveImageUrl(i.url)),
      seller: { id: p.seller_id, name: p.seller_name, reputation: parseFloat(p.seller_rep), photoUrl: p.seller_photo }
    })
  } catch (err) {
    console.error('[products.getOne]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// PUT /api/products/:productId
exports.update = async (req, res) => {
  try {
    const { productId } = req.params
    const isAdmin = req.user.role === 'admin'
    const prod = await pool.query('SELECT * FROM products WHERE product_id = $1', [productId])
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' })
    if (!isAdmin && prod.rows[0].seller_id !== req.user.userId)
      return res.status(403).json({ error: 'No tienes permiso para modificar este producto' })

    // Verificar órdenes activas
    const activeOrder = await pool.query(
      `SELECT order_id FROM orders WHERE product_id = $1 AND status IN ('confirmed','delivered')`, [productId]
    )
    if (activeOrder.rows.length) return res.status(409).json({ error: 'No se puede editar un producto con órdenes activas' })

    const { title, description, price, categoryId, condition, stock, adminReason } = req.body
    const fields = []; const values = []; let idx = 1
    if (title)       { fields.push(`title = $${idx++}`);       values.push(title.trim()) }
    if (description) { fields.push(`description = $${idx++}`); values.push(description.trim()) }
    if (price)       { fields.push(`price = $${idx++}`);       values.push(price) }
    if (categoryId)  { fields.push(`category_id = $${idx++}`); values.push(categoryId) }
    if (condition)   { fields.push(`condition = $${idx++}`);   values.push(condition) }
    if (stock != null) { fields.push(`stock = $${idx++}`);     values.push(parseInt(stock)) }

    values.push(productId)
    await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE product_id = $${idx}`, values)

    // Reemplazar imágenes si vienen nuevas
    const files = req.files || []
    if (files.length > 0) {
      const isProd = process.env.NODE_ENV === 'production'
      await pool.query('DELETE FROM product_images WHERE product_id = $1', [productId])
      for (let i = 0; i < files.length; i++) {
        const url = isProd
          ? `data:${files[i].mimetype};base64,${files[i].buffer.toString('base64')}`
          : `/uploads/${files[i].filename}`
        await pool.query('INSERT INTO product_images (product_id, url, position) VALUES ($1,$2,$3)',
          [productId, url, i])
      }
    }

    if (isAdmin) {
      const productTitle = title ? title.trim() : prod.rows[0].title
      await createNotification({
        userId: prod.rows[0].seller_id,
        type: 'order_status',
        message: `Un administrador ha modificado tu producto: ${productTitle}. Razón: ${adminReason || 'No especificada'}`,
        resourceId: productId,
        resourceType: 'product',
      })
    }

    return res.status(200).json({ productId, updated: true, updatedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[products.update]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// DELETE /api/products/:productId — soft delete
exports.remove = async (req, res) => {
  try {
    const { productId } = req.params
    const prod = await pool.query('SELECT * FROM products WHERE product_id = $1', [productId])
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' })
    if (prod.rows[0].seller_id !== req.user.userId) return res.status(403).json({ error: 'No tienes permiso para modificar este producto' })

    await pool.query(`UPDATE products SET status = 'deleted' WHERE product_id = $1`, [productId])
    return res.status(200).json({ productId, deleted: true })
  } catch (err) {
    console.error('[products.remove]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/products/my — productos del usuario autenticado
exports.myProducts = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.product_id, p.title, p.price, p.condition, p.status, p.stock, p.created_at,
              (SELECT url FROM product_images WHERE product_id = p.product_id ORDER BY position LIMIT 1) AS image_url
       FROM products p
       WHERE p.seller_id = $1 AND p.status != 'deleted'
       ORDER BY p.created_at DESC`,
      [req.user.userId]
    )
    return res.status(200).json(result.rows.map(p => ({
      productId: p.product_id, title: p.title, price: parseFloat(p.price),
      condition: p.condition, status: p.status, stock: p.stock, createdAt: p.created_at,
      imageUrl: resolveImageUrl(p.image_url)
    })))
  } catch (err) {
    console.error('[products.myProducts]', err)
    return res.status(500).json({ error: 'Error del servidor' })
  }
}

// GET /api/categories
exports.getCategories = async (req, res) => {
  try {
    const result = await pool.query('SELECT category_id, name FROM categories ORDER BY name')
    return res.status(200).json(result.rows)
  } catch (err) {
    return res.status(500).json({ error: 'Error del servidor' })
  }
}
