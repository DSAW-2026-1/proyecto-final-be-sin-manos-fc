const router = require('express').Router()
const auth = require('../middleware/auth')
const admin = require('../middleware/admin')
const adminCtrl = require('../controllers/admin.controller')
const prodsCtrl = require('../controllers/products.controller')

router.use(auth, admin)

router.get('/dashboard', adminCtrl.dashboard)
router.get('/users', adminCtrl.listUsers)
router.patch('/users/:userId/suspend', adminCtrl.suspendUser)
router.delete('/users/:userId', adminCtrl.deleteUser)
router.get('/products', adminCtrl.listProducts)
router.put('/products/:productId', prodsCtrl.update)
router.delete('/products/:productId', adminCtrl.deleteProduct)
router.get('/reports', adminCtrl.listReports)
router.patch('/reports/:reportId', adminCtrl.updateReport)

module.exports = router
