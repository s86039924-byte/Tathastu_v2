const mongoose=require('mongoose');
const userSchema=new mongoose.Schema({
 name:{type:String,required:true,trim:true},
 phone:{type:String,required:true,unique:true},
 password:{type:String,required:true},
 role:{type:String,enum:['student','teacher','admin'],default:'student'},
 meta:{type:mongoose.Schema.Types.Mixed,default:{}}
},{timestamps:true});
module.exports=mongoose.model('User',userSchema);
