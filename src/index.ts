import "./env.ts";

import express from "express";
import mongoose from "mongoose";
import Jwt from "jsonwebtoken";
const JWT_PASSWORD = process.env.JWT_PASSWORD;
if (!JWT_PASSWORD) {
  throw new Error("JWT_PASSWORD is missing. Set it in your environment variables.");
}
import { connectDatabase, LinkModel, userModel } from "./db.ts";
import { ContentModel } from "./db.ts";
import { userMiddleware } from "./middleware.ts";
import z from "zod";
import bcrypt from "bcrypt";
import { random } from "./random.ts";
import cors from "cors";
import rateLimit from "express-rate-limit";
import ragRouter from "./routes/rag.ts";
import { initializeVectorDB } from "./services/vectordbService.ts";
import { indexContent, unindexContent } from "./services/ragService.ts";

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Vary", "Origin");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Rate limiter for general API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: "Too many authentication attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Mount RAG chat endpoint
app.use("/api/v1/chat", ragRouter);

const port = 3000;

// Configuration constants
const MAX_HASH_GENERATION_ATTEMPTS = 5;

app.get("/", (_req, res) => {
  res.send("Welcome!");
});

app.post("/api/v1/signup", authLimiter, async (req, res) => {
  // input validation
  const required_body = z
    .object({
      username: z.string().min(3, "Username must be at least 3 chars"),
      email: z.string().email("Invalid email address"),
      password: z.string().superRefine((val, ctx) => {
        if (val.length < 8)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Must be 8+ characters",
          });
        if (val.length > 30)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Must be <30 characters",
          });
        if (!/[A-Z]/.test(val))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Must include uppercase letter",
          });
        if (!/[a-z]/.test(val))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Must include lowercase letter",
          });
        if (!/[0-9]/.test(val))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Must include a digit",
          });
        if (!/[!@#$%^&*().,?<>|]/.test(val))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Must include a special character",
          });
      }),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: "Passwords don't match",
      path: ["confirmPassword"],
    });
  // Parsing the required body.
  const parsedData = required_body.safeParse(req.body);

  if (!parsedData.success) {
    res.status(403).json({
      message: "Invalid Password or Username",
      error: parsedData.error,
    });
    return;
  }

  const username = req.body.username;
  const email = req.body.email?.toLowerCase();
  const password = req.body.password;

  // Explicit check for existing email before inserting
  const existingUser = await userModel.findOne({ email });
  if (existingUser) {
    res
      .status(409)
      .json({ message: "An account with this email already exists" });
    return;
  }

  const hashedPwd = await bcrypt.hash(password, 10);

  try {
    await userModel.create({
      username,
      email,
      password: hashedPwd,
    });

    res.json({ message: "user signed up." });
  } catch (e: any) {
    // MongoDB duplicate key error
    if (e?.code === 11000) {
      const field = Object.keys(e.keyPattern || {})[0] || "field";
      res
        .status(409)
        .json({ message: `An account with this ${field} already exists` });
    } else {
      console.error("Signup error:", e instanceof Error ? e.message : "Unknown error");
      res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  }
});

app.post("/api/v1/signin", authLimiter, async (req, res) => {
  // Input validation using Zod
  const signinSchema = z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(1, "Password is required"),
  });

  const parsedData = signinSchema.safeParse(req.body);

  if (!parsedData.success) {
    res.status(400).json({
      message: "Invalid input",
      error: parsedData.error,
    });
    return;
  }

  // Use validated data from parsedData.data
  const email = parsedData.data.email.toLowerCase();
  const password = parsedData.data.password;

  const response = await userModel.findOne({
    email,
  });

  if (!response) {
    res.status(403).json({
      message: "user does not exist",
    });
    return;
  }

  //@ts-ignore
  const matched_pwd = await bcrypt.compare(password, response.password);

  if (matched_pwd) {
    const token = Jwt.sign(
      {
        //@ts-ignore
        id: response._id,
      },
      JWT_PASSWORD,
    );

    res.json({
      token,
      email: response.email,
    });
  } else {
    res.status(403).json({
      message: "Invalid Credentials",
    });
  }
});

app.post("/api/v1/content", apiLimiter, userMiddleware, async (req, res) => {
  try {
    const title = req.body.title;
    const link = req.body.link;
    const type = req.body.type;
    const tags = req.body.tags;

    const content = await ContentModel.create({
      title,
      link,
      type,
      userId: req.userId as string,
      tags: tags || [],
    });

    // 🆕 Automatically index for RAG (required for content to be searchable)
    try {
      await indexContent(
        req.userId as string,
        content._id.toString(),
        title,
        link,
        title,
      );
    } catch (ragError) {
      // RAG indexing is critical - delete the content if indexing fails
      console.error(
        "❌ RAG indexing failed, rolling back content creation:",
        ragError instanceof Error ? ragError.message : "Unknown error",
      );
      await ContentModel.deleteOne({ _id: content._id });
      throw new Error(
        `Failed to index content for RAG: ${ragError instanceof Error ? ragError.message : "Unknown error"}`,
      );
    }

    res.json({
      message: "Content Added",
    });
  } catch (error) {
    console.error("Error creating content:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({
      error: "Failed to create content",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/v1/content", apiLimiter, userMiddleware, async (req, res) => {
  const userId = req.userId as string;
  const content = await ContentModel.find({
    userId: userId,
  }).populate("userId", "username email");
  res.json({
    content,
  });
});

app.delete("/api/v1/content", apiLimiter, userMiddleware, async (req, res) => {
  try {
    const { contentId } = req.body;

    if (!contentId) {
      return res
        .status(400)
        .json({ message: "contentId is required in request body" });
    }

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return res.status(400).json({ message: "Invalid Content ID format" });
    }

    // First delete from MongoDB
    const result = await ContentModel.deleteOne({
      _id: new mongoose.Types.ObjectId(contentId),
      userId: req.userId as string,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Content not found or you are not authorized to delete it",
      });
    }

    // Then remove from RAG/Pinecone index
    try {
      await unindexContent(contentId);
    } catch (ragError) {
      console.error("⚠️  Pinecone deletion failed:", ragError instanceof Error ? ragError.message : "Unknown error");
      // Don't fail the request if Pinecone deletion fails
      // Content is already deleted from MongoDB
    }

    res.json({ message: "Content deleted successfully" });
  } catch (err) {
    console.error("Error deleting content:", err instanceof Error ? err.message : "Unknown error");
    res.status(500).json({ message: "Error deleting content", error: err });
  }
});

app.post(
  "/api/v1/brain/share",
  apiLimiter,
  userMiddleware,
  async (req, res) => {
    const share = req.body.share;

    if (share) {
      const existingLink = await LinkModel.findOne({ userId: req.userId as string });
      if (existingLink) {
        res.json({
          hash: existingLink.hash,
        });
        return;
      } else {
        // Generate a unique hash that doesn't collide with existing ones
        let hash = random(10);
        let existingHash = await LinkModel.findOne({ hash });
        let attempts = 0;

        // Regenerate if collision detected (rare but possible)
        while (existingHash && attempts < MAX_HASH_GENERATION_ATTEMPTS) {
          hash = random(10);
          existingHash = await LinkModel.findOne({ hash });
          attempts++;
        }

        if (attempts >= MAX_HASH_GENERATION_ATTEMPTS) {
          res.status(500).json({
            message: "Failed to generate unique share link. Please try again.",
          });
          return;
        }

        await LinkModel.create({
          userId: req.userId as string,
          hash: hash,
        });
        res.json({
          hash,
        });
      }
    } else {
      await LinkModel.deleteOne({
        userId: req.userId as string,
      });
      res.json({
        message: "Removed Link",
      });
    }
  },
);

app.get("/api/v1/brain/:shareLink", apiLimiter, async (req, res) => {
  try {
    const hash = req.params.shareLink;
    if (!hash) return res.status(400).json({ message: "missing share link" });

    const link = await LinkModel.findOne({ hash }).lean();
    if (!link) return res.status(404).json({ message: "wrong link" });

    const userId = link.userId;
    if (!userId) return res.status(500).json({ message: "invalid link data" });

    const contents = await ContentModel.find({ userId }).lean();

    const user = await userModel.findById(userId).select("username").lean();

    if (!user) return res.status(404).json({ message: "user not found" });

    res.json({
      username: user.username,
      contents,
    });
  } catch (err) {
    console.error("Server error:", err instanceof Error ? err.message : "Unknown error");
    res.status(500).json({ message: "server error" });
  }
});

// Initialize VectorDB and start server
async function startServer() {
  try {
    await connectDatabase();
  } catch (error) {
    console.error(
      "❌ Failed to connect MongoDB:",
      error instanceof Error ? error.message : error,
    );
    console.error(
      "Check MONGO_URL in .env and ensure your Atlas cluster DNS/network settings are valid.",
    );
    process.exit(1);
  }

  let ragAvailable = true;
  try {
    await initializeVectorDB();
  } catch (error) {
    ragAvailable = false;
    console.error("Failed to initialize VectorDB:", error);
    console.warn(
      "Starting server in degraded mode - RAG features will be unavailable",
    );
    console.warn(
      "Ensure Pinecone API key and connection are properly configured",
    );
  }

  app.listen(port, () => {
    if (ragAvailable) {
      return;
    }

    // Server started in degraded mode
  });
}

startServer();
