const express = require('express')
const router = express.Router()
const ansibleController =   require('../controllers/ansible.controller');

// run a playbook
router.post('/launch/', ansibleController.run);
router.get('/job/:id', ansibleController.getJob);
router.put('/job/:id', ansibleController.updateJob);
router.post('/job/:id/abort/', ansibleController.abortJob);
router.get('/jobs/', ansibleController.findAllJobs);
router.delete('/job/:id', ansibleController.deleteJob);
module.exports = router
