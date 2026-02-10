import dotenv from 'dotenv';
dotenv.config();

import express from "express";
import mongoose from "mongoose"
import Jwt from "jsonwebtoken"
import { JWT_PASSWORD } from "./jwt_password.ts";
import {LinkModel, userModel} from "./db.ts";
import { ContentModel } from "./db.ts";
import { userMiddleware } from "./middleware.ts";
import z from "zod";
import bcrypt from "bcrypt";
import { random } from "./random.ts";
import cors from 'cors';
import ragRouter from "./routes/rag.ts";
import { initializeVectorDB } from "./services/vectordbService.ts";
import { indexContent, unindexContent } from "./services/ragService.ts";


const app = express();
app.use(express.json());
app.use(cors());

// Mount RAG chat endpoint
app.use("/api/v1/chat", ragRouter);

const port = 3000;


app.get("/", (_req, res) => {
    res.send("Welcome!");
});


app.post("/api/v1/signup", async (req, res) => {
    // input validation 
    const required_body = z.object({
    username: z.string().min(3, "Username must be at least 3 chars"),
    email: z.string().email("Invalid email address"),
    password: z.string().superRefine((val, ctx) => {
    if (val.length < 8)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be 8+ characters" });
    if (val.length > 30)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be <30 characters" });
    if (!/[A-Z]/.test(val))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must include uppercase letter" });
    if (!/[a-z]/.test(val))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must include lowercase letter" });
    if (!/[0-9]/.test(val))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must include a digit" });
    if (!/[!@#$%^&*().,?<>|]/.test(val))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must include a special character" });
  }),
    confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
});
    // Parsing the required body.
    const parsedData = required_body.safeParse(req.body);

    if(!parsedData.success){
        res.status(403).json({
            message: "Invalid Password or Username",
            error:parsedData.error
        })
        return
    }

    const username = req.body.username;
    const email = req.body.email;
    const password = req.body.password;

    // -> hashing the password if error show the error code

    const hashedPwd = await bcrypt.hash(password,10);

    try {
        await userModel.create({
            username: username,
            email: email,
            password: hashedPwd
        })

        res.json({
            message: "user signed up."
        })
    } catch(e) {
        res.status(411).json({
            message: "User exist already"
        })
    }
})


app.post("/api/v1/signin", async (req, res) => {
    // Input validation using Zod
    const signinSchema = z.object({
        username: z.string().min(1, "Username/email is required"),
        password: z.string().min(1, "Password is required")
    });

    const parsedData = signinSchema.safeParse(req.body);

    if (!parsedData.success) {
        res.status(400).json({
            message: "Invalid input",
            error: parsedData.error
        });
        return;
    }

    const username = req.body.username;
    const password = req.body.password;

    const response = await userModel.findOne({
        $or: [{ username }, { email: username }]
    })

    if(!response){
        res.status(403).json({
            message:"user does not exist"
        })
        return;
    }

    //@ts-ignore
    const matched_pwd = await bcrypt.compare(password, response.password)

    if(matched_pwd) {
        const token = Jwt.sign({
            //@ts-ignore
            id:response._id
        }, JWT_PASSWORD)

        res.json({
            token
        })
    }
    else{
        res.status(403).json({
            message: "Invalid Credentials"
        })
    }
})

app.post("/api/v1/content", userMiddleware, async (req, res) => {
    try {
        const title = req.body.title;
        const link = req.body.link;
        const type = req.body.type;
        const tags = req.body.tags

        const content = await ContentModel.create({
            title,
            link,
            type,
            // @ts-ignore
            userId: req.userId,
            tags: tags || [],
        })

        // 🆕 Automatically index for RAG (required for content to be searchable)
        try {
            // @ts-ignore
            await indexContent(req.userId, content._id.toString(), title, link, title);
            console.log(`✅ Content indexed for RAG: ${title}`);
        } catch (ragError) {
            // RAG indexing is critical - delete the content if indexing fails
            console.error("❌ RAG indexing failed, rolling back content creation:", ragError);
            await ContentModel.deleteOne({ _id: content._id });
            throw new Error(`Failed to index content for RAG: ${ragError instanceof Error ? ragError.message : 'Unknown error'}`);
        }

        res.json({
            message: "Content Added"
        })
    } catch (error) {
        console.error("Error creating content:", error);
        res.status(500).json({
            error: "Failed to create content",
            message: error instanceof Error ? error.message : "Unknown error"
        });
    }
})

app.get("/api/v1/content", userMiddleware, async (req, res) => {
    //@ts-ignore
    const userId = req.userId;
    const content = await ContentModel.find({
        userId: userId
    }).populate("userId", "username")
    res.json({
        content
    })
})

app.delete("/api/v1/content", userMiddleware, async (req, res) => {
  try {
    const { contentId } = req.body;

    if (!contentId) {
      return res.status(400).json({ message: "contentId is required in request body" });
    }

    if (!mongoose.Types.ObjectId.isValid(contentId)) {
      return res.status(400).json({ message: "Invalid Content ID format" });
    }

    // First delete from MongoDB
    const result = await ContentModel.deleteOne({
      _id: new mongoose.Types.ObjectId(contentId),
      // @ts-ignore
      userId: req.userId,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Content not found or you are not authorized to delete it",
      });
    }

    console.log(`✅ Content deleted from MongoDB: ${contentId}`);

    // Then remove from RAG/Pinecone index
    try {
      await unindexContent(contentId);
      console.log(`✅ Content removed from Pinecone: ${contentId}`);
    } catch (ragError) {
      console.error("⚠️  Pinecone deletion failed:", ragError);
      // Don't fail the request if Pinecone deletion fails
      // Content is already deleted from MongoDB
    }

    res.json({ message: "Content deleted successfully" });
  } catch (err) {
    console.error("Error deleting content:", err);
    res.status(500).json({ message: "Error deleting content", error: err });
  }
});


app.post("/api/v1/brain/share", userMiddleware, async(req, res) => {
    const share = req.body.share;

    if(share) {
        //@ts-ignore
        const existingLink = await LinkModel.findOne({userId:req.userId});
        if(existingLink) {
            res.json({
                hash: existingLink.hash
            })
            return;
        }
        else{
            // Generate a unique hash that doesn't collide with existing ones
            let hash = random(10);
            let existingHash = await LinkModel.findOne({ hash });
            let attempts = 0;
            const MAX_ATTEMPTS = 5;
            
            // Regenerate if collision detected (rare but possible)
            while (existingHash && attempts < MAX_ATTEMPTS) {
                hash = random(10);
                existingHash = await LinkModel.findOne({ hash });
                attempts++;
            }
            
            if (attempts >= MAX_ATTEMPTS) {
                res.status(500).json({
                    message: "Failed to generate unique share link. Please try again."
                });
                return;
            }
            
            await LinkModel.create({
                //@ts-ignore
                userId: req.userId,
                hash: hash
            })
            res.json({
                hash
            })
        }
    }
    else{
        await LinkModel.deleteOne({
            //@ts-ignore
            userId: req.userId
        })
        res.json({
            message: "Removed Link"
        })
    }
})

app.get("/api/v1/brain/:shareLink", async (req, res) => {
  try {
    const hash = req.params.shareLink;
    console.log("Received shareLink:", hash);
    if (!hash) return res.status(400).json({ message: "missing share link" });

    const link = await LinkModel.findOne({ hash }).lean();
    console.log("Found link:", link);
    if (!link) return res.status(404).json({ message: "wrong link" });

    const userId = link.userId;
    if (!userId) return res.status(500).json({ message: "invalid link data" });

    const contents = await ContentModel.find({ userId }).lean();
    console.log("User contents:", contents);

    const user = await userModel.findById(userId).select("username").lean();
    console.log("Found user:", user);

    if (!user) return res.status(404).json({ message: "user not found" });

    res.json({
      username: user.username,
      contents,
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ message: "server error" });
  }
});


// Initialize VectorDB and start server
async function startServer() {
  try {
    // Initialize Pinecone index
    console.log("🔧 Initializing VectorDB...");
    await initializeVectorDB();
    
    app.listen(port, () => {
      console.log(`✅ Server running at http://localhost:${port}`);
      console.log(`📊 RAG Chat endpoint: http://localhost:${port}/api/v1/chat`);
      console.log(`🤖 Ollama should be running at ${process.env.OLLAMA_API || 'http://localhost:11434'}`);
    });
  } catch (error) {
    console.error("❌ Failed to initialize VectorDB:", error);
    console.warn("⚠️  Starting server in degraded mode - RAG features will be unavailable");
    console.warn("📌 Ensure Pinecone API key and connection are properly configured");
    
    // Start server anyway - RAG features won't work but other API endpoints will be available
    app.listen(port, () => {
      console.log(`✅ Server running at http://localhost:${port} (degraded mode)`);
      console.log(`⚠️  RAG Chat features are currently unavailable`);
    });
  }
}

startServer();
