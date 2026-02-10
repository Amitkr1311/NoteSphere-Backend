import axios from "axios";

interface RAGContext {
  text: string;
  contentId: string;
  score: number;
}

const OLLAMA_API = process.env.OLLAMA_API || "http://localhost:11434";
const LLM_MODEL = process.env.LLM_MODEL || "mistral"; // Free, fast model

/**
 * Generate answer using free Ollama LLM
 * Runs locally on user's machine, completely free
 */
export async function generateAnswer(
  question: string,
  context: RAGContext[]
): Promise<string> {
  try {
    const contextText = context
      .map((c, idx) => `[Post ${idx + 1}]\n${c.text}\n`)
      .join("\n---\n\n");

    const prompt = `You are a helpful assistant answering questions based on the user's saved content.

User's Question: ${question}

Retrieved Content from ${context.length} Saved Post${context.length > 1 ? 's' : ''}:
${contextText}

Based on the context above:
1. Provide a clear summary answering the user's question
2. If multiple relevant posts are found, briefly describe what each post contains
3. If the context doesn't contain relevant information, say so clearly

Keep your answer helpful and well-structured (3-5 sentences).`;

    const response = await axios.post(`${OLLAMA_API}/api/generate`, {
      model: LLM_MODEL,
      prompt: prompt,
      stream: false,
      temperature: 0.7,
      timeout: 15000,
    });

    return response.data.response || "Unable to generate answer";
  } catch (error) {
    console.error("Error generating answer:", error);
    throw new Error(
      "Failed to generate answer. Make sure Ollama is running: ollama serve"
    );
  }
}

/**
 * Generate a brief title for the chat conversation
 */
export async function generateChatTitle(question: string): Promise<string> {
  try {
    const response = await axios.post(`${OLLAMA_API}/api/generate`, {
      model: LLM_MODEL,
      prompt: `Generate a very short (3-5 words) title for this question: "${question}". Only output the title, nothing else.`,
      stream: false,
      temperature: 0.5,
      timeout: 15000,
    });

    const title = response.data?.response;
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
