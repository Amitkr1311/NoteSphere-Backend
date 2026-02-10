import dotenv from 'dotenv';
dotenv.config();

import mongoose from "mongoose";
import { Schema } from "mongoose";
import  MONGO_URL  from "./mongo_url.ts";

//mongoose.connect("<url>")
mongoose.connect(`${MONGO_URL}`)

const UserSchema = new Schema({
    username:{type: String, required:true, unique:true},
    email:{type: String, required:true, unique:true},
    password:{type: String, required: true},
    createdAt: {type: Date, default: Date.now}
});

export const userModel =  mongoose.model("users", UserSchema);

// export default userModel;

const ContentSchema = new Schema({
    title: String,
    link: String,
    type: String,
    tags: [{type: mongoose.Types.ObjectId, ref: "Tag"}],
    userId: {type : mongoose.Types.ObjectId, ref: "users", required: true}
})

export const ContentModel = mongoose.model("contents", ContentSchema);

const LinkSchema = new Schema({
    userId: {type: mongoose.Types.ObjectId, ref: "users", unique:true, required: true},
    hash: String
})

export const LinkModel = mongoose.model("Sharelinks", LinkSchema);
//export default {ContentModel, userModel};