import express,  { type Request, type Response } from "express";
import { Types } from "mongoose";
import rateLimit from 'express-rate-limit';
import { userMiddleware } from "../middleware.ts";
import { answerQuestion, indexContent, unindexContent } from "../services/ragService.ts";

const router = express.Router();

// Rate limiter for RAG endpoints (more permissive for chat)
const ragLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 requests per windowMs
    message: 'Too many AI requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Chat endpoint - Answer user questions about their content
 * POST /api/v1/chat
 */
router.post("/", ragLimiter, userMiddleware, async (req: Request, res: Response) => {
  try {
    const { question } = req.body;
    const userId = (req as any).userId;

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: "Question cannot be empty" });
    }

    const trimmedQuestion = question.trim();
    const MAX_QUESTION_LENGTH = 1000;
    if (trimmedQuestion.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({
        error: `Question is too long. Maximum length is ${MAX_QUESTION_LENGTH} characters`,
      });
    }
    const result = await answerQuestion(userId, trimmedQuestion);

    res.json({
      success: true,
      answer: result.answer,
      sources: result.sources,
      title: result.title,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      error: "Failed to process question",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Index new content for RAG
 * Called from the content creation endpoint
 */
router.post(
  "/index",
  ragLimiter,
  userMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { contentId, title, link, text } = req.body;
      const userId = (req as any).userId;

      if (!contentId || !title) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Extract text from link if available
      // For now, we'll use title as the main content
      const contentText = text || title;

      await indexContent(userId, contentId, title, link, contentText);

      res.json({
        success: true,
        message: "Content indexed successfully",
      });
    } catch (error) {
      console.error("Indexing error:", error);
      res.status(500).json({
        error: "Failed to index content",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * Remove content from RAG index
 * Called when content is deleted
 */
router.delete(
  "/:contentId",
  ragLimiter,
  userMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { contentId } = req.params;

      if(!contentId) {
        return res.status(400).json({ error: "Content ID is required" });
      }

      if (!Types.ObjectId.isValid(contentId)) {
        return res.status(400).json({ error: "Invalid Content ID format" });
      }

      await unindexContent(contentId);

      res.json({
        success: true,
        message: "Content removed from index",
      });
    } catch (error) {
      console.error("Deletion error:", error);
      res.status(500).json({
        error: "Failed to remove content",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export default router;
