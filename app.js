require('dotenv').config();
const express=require('express');
const cors=require('cors');
const connectDB=require('./config/db');
const authRoutes=require('./routes/auth.routes');
const { mentorRouter } = require('./routes/mentor');
const { studentRouter } = require('./routes/student/index');
const app=express();

app.use(cors());
app.use(express.json());

app.get('/',(req,res)=>res.json({success:true,message:'API Running'}));
app.use('/api/auth',authRoutes);
app.use('/mentor', mentorRouter);
app.use('/student', studentRouter);

const PORT = process.env.PORT || 4000;
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});

module.exports=app;
