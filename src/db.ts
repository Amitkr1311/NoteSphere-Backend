import mongoose from "mongoose";
import { Schema } from "mongoose";
import MONGO_URL from "./mongo_url.ts";

function getMongoHostFromUrl(connectionString: string): string | null {
  try {
    const withoutProtocol = connectionString
      .replace(/^mongodb\+srv:\/\//, "")
      .replace(/^mongodb:\/\//, "");
    const hostPart = withoutProtocol.split("@").pop()?.split("/")[0] ?? "";
    return hostPart || null;
  } catch {
    return null;
  }
}

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URL, {
      serverSelectionTimeoutMS: 10000,
    });

    // Drop the stale unique index on username if it still exists.
    // Mongoose schema changes don't remove existing MongoDB indexes.
    try {
      await mongoose.connection.db!.collection("users").dropIndex("username_1");
    } catch (_) {
      // Index doesn't exist — that's fine, nothing to do
    }
  } catch (error) {
    const host = getMongoHostFromUrl(MONGO_URL);
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("ENOTFOUND") ||
      message.includes("querySrv ENOTFOUND")
    ) {
      throw new Error(
        `Could not resolve MongoDB SRV host${host ? ` (${host})` : ""}. Verify your Atlas cluster hostname in MONGO_URL and check DNS/network access.`,
      );
    }

    throw new Error(`MongoDB connection failed: ${message}`);
  }
}

const UserSchema = new Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const userModel = mongoose.model("users", UserSchema);

const ContentSchema = new Schema({
  title: String,
  link: String,
  type: String,
  tags: [{ type: mongoose.Types.ObjectId, ref: "Tag" }],
  userId: { type: mongoose.Types.ObjectId, ref: "users", required: true },
});

export const ContentModel = mongoose.model("contents", ContentSchema);

const LinkSchema = new Schema({
  userId: {
    type: mongoose.Types.ObjectId,
    ref: "users",
    unique: true,
    required: true,
  },
  hash: String,
});

export const LinkModel = mongoose.model("Sharelinks", LinkSchema);
