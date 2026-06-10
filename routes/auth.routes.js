const router=require('express').Router();
const {register,login,registerMentor,loginMentor,getAllUsers,
  processQuery, continueFollowup}=require('../controllers/auth.controller');

router.post('/register',register);
router.post('/login',login);

// Teacher/mentor authentication
router.post('/mentor/register',registerMentor);
router.post('/mentor/login',loginMentor);
// List all users
router.get('/users', getAllUsers);

// Process query
router.post('/process-query', processQuery);

// Continue follow-up
router.post('/continue-followup', continueFollowup);

module.exports=router;
