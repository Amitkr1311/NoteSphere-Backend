import "./env.ts";

const val = process.env.MONGO_URL;
if (!val) {
  throw new Error("MONGO_URL is not defined in environment variables");
}
const MONGO_URL = val;
export default MONGO_URL;