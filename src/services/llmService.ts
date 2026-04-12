import "../env.ts";
import axios from "axios";

interface RAGContext {
  text: string;
  contentId: string;
  score: number;
  title?: string;
  dashboardLink?: string;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL; // Free tier available

/**
 * Generate answer using Google Gemini API
 * Free tier: 15 requests/minute, 1500 requests/day
 */
export async function generateAnswer(
  question: string,
  context: RAGContext[]
): Promise<string> {
  try {
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in environment variables");
    }

    if (!GEMINI_MODEL) {
      throw new Error("GEMINI_MODEL is not set in environment variables (e.g., gemini-1.5-flash)");
    }

    const contextText = context
      .map((c, idx) => {
        const title = c.title || "Saved post";
        const link = c.dashboardLink || "";
        return `[Post ${idx + 1}]
Title: ${title}
Dashboard Link: ${link}
Snippet:
${c.text}
`;
      })
      .join("\n---\n\n");

    const prompt = `You are a helpful assistant for a personal knowledge dashboard.

User's Question: ${question}

Retrieved Posts (${context.length}):
${contextText}

Instructions:
1. ONLY use the retrieved posts above. Do not add outside knowledge or unrelated content.
2. Do NOT include a "Sources" section.
3. If only one post is relevant, answer strictly about that post and include its Dashboard Link.
4. If multiple posts are relevant, provide a short summary for each post and include each Dashboard Link.
5. If the retrieved posts do not answer the question, say you couldn't find relevant saved content.

Formatting rules:
- Output plain text only.
- Do NOT use Markdown (no **bold**, no bullet symbols).

Keep the response concise and focused on the saved posts.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        }
      },
      {
        timeout: 15000,
      }
    );

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to generate answer";
  } catch (error) {
    console.error("Error generating answer:", error);
    throw new Error(
      "Failed to generate answer. Check your GEMINI_API_KEY and internet connection."
    );
  }
}

/**
 * Generate a brief title for the chat conversation
 */
export async function generateChatTitle(question: string): Promise<string> {
  try {
    if (!GEMINI_API_KEY || !GEMINI_MODEL) {
      return question.substring(0, 50);
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: `Generate a very short (3-5 words) title for this question: "${question}". Only output the title, nothing else.`
          }]
        }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 50,
        }
      },
      {
        timeout: 15000,
      }
    );

    const title = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!title || typeof title !== 'string') {
      return "Chat Conversation";
    }
    
    return title.substring(0, 50).trim() || "Chat Conversation";
  } catch (error) {
    console.error("Error generating title:", error);
    return question.substring(0, 50);
  }
}

/**
 * Rerank results to ensure quality
 * Uses semantic similarity and relevance scoring
 */
export function rerankResults(
  results: RAGContext[],
  topK: number = 5
): RAGContext[] {
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
