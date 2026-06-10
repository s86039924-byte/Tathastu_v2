const jwt=require('jsonwebtoken');
module.exports=(req,res,next)=>{
 try{
  const token=req.headers.authorization?.split(' ')[1];
  if(!token) return res.status(401).json({success:false,message:'Unauthorized'});
  req.user=jwt.verify(token,process.env.JWT_SECRET);
  next();
 }catch(e){
  res.status(401).json({success:false,message:'Invalid token'});
 }
};
