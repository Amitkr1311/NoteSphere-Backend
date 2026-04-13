import "./env.ts";

const val = process.env.MONGO_URL || process.env.MONGODB_URI;
if (!val) {
  throw new Error("MONGO_URL or MONGODB_URI is not defined in environment variables");
}
const MONGO_URL = val;
export default MONGO_URL;