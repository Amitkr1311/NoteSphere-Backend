import "../env.ts";
import { createEmbedding, createEmbeddings, chunkText } from "./embeddingService.ts";
import {
  upsertChunks,
  searchChunks,
  deleteChunksForContent,
} from "./vectordbService.ts";
import { generateAnswer, generateChatTitle } from "./llmService.ts";
import { extractContentFromUrl, createRichContent } from "./contentExtractor.ts";

function buildDashboardLink(contentId: string): string {
  const baseUrl = process.env.DASHBOARD_BASE_URL || "";
  const path = `/dashboard/content/${contentId}`;
  if (!baseUrl) {
    return path;
  }
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function extractTitleFromText(text: string): string | null {
  const match = text.match(/^Title:\s*(.+)$/m);
  return match?.[1]?.trim() || null;
}

/**
 * Check if question requires database search (industry-standard approach)
 * Returns false for greetings, small talk, and general questions that don't need user's saved content
 */
function requiresDatabaseSearch(question: string): boolean {
  const lowerQuestion = question.toLowerCase().trim();
  
  // Remove punctuation and extra spaces for better matching
  const normalized = lowerQuestion.replace(/[,!.?]+/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Common greetings and small talk patterns that don't need DB search
  const nonSearchPatterns = [
    // Pure greetings
    /^(hi|hii|hello|hey|hola|greetings|good morning|good afternoon|good evening)$/,
    // Greetings with how are you
    /^(hi|hii|hello|hey|hola|greetings)\s+(how are you|how r u|how are u|how r you)$/,
    // Just how are you
    /^(how are you|how r u|how are u|how r you)$/,
    // What's up variations
    /^what'?s up$/,
    /^(hi|hello|hey)\s+what'?s up$/,
    /^sup$/,
    // Thanks
    /^thanks?( you)?( very much)?$/,
    /^thank you( very much)?$/,
    // Goodbyes
    /^(bye|goodbye|see you|see ya|cya|later)$/,
    // Simple responses
    /^(ok|okay|yes|yep|yeah|yup|no|nope|nah|cool|nice|great|awesome)$/,
    // Meta questions about the bot
    /^(help|what can you do|who are you|what are you)$/,
  ];
  
  // Check if question matches any non-search pattern
  for (const pattern of nonSearchPatterns) {
    if (pattern.test(normalized)) {
      return false;
    }
  }
  
  // If question is very short (3 words or less) and contains only casual words
  const words = normalized.split(/\s+/);
  const casualWords = ['hi', 'hii', 'hello', 'hey', 'hola', 'how', 'are', 'you', 'whats', 'up', 'thanks', 'thank', 'bye', 'ok', 'yes', 'no'];
  
  if (words.length <= 3 && words.every(word => casualWords.includes(word))) {
    return false;
  }
  
  // Default: assume it needs search
  return true;
}

/**
 * Generate a friendly response without database search
 */
function generateBasicResponse(question: string): string {
  const lowerQuestion = question.toLowerCase().trim();
  
  if (/^(hi|hello|hey|hola|greetings)/.test(lowerQuestion)) {
    return "Hello! I'm your personal knowledge assistant. I can help you find information from your saved content. Just ask me anything about what you've saved!";
  }
  
  if (/how are you/.test(lowerQuestion)) {
    return "I'm doing great, thanks for asking! I'm here to help you explore and find insights from your saved content. What would you like to know?";
  }
  
  if (/what can you do|help/.test(lowerQuestion)) {
    return "I can help you search through your saved content and answer questions about it. For example, you can ask:\n• 'What did I save about React?'\n• 'Summarize my notes on machine learning'\n• 'Find posts about UI design'\n\nJust ask naturally, and I'll search your saved content!";
  }
  
  if (/who are you/.test(lowerQuestion)) {
    return "I'm your AI assistant for searching and understanding your saved content.";
  }
  
  if (/thanks?|thank you/.test(lowerQuestion)) {
    return "You're welcome! Feel free to ask me anything about your saved content anytime.";
  }
  
  if (/bye|goodbye/.test(lowerQuestion)) {
    return "Goodbye! Come back anytime you need help with your saved content.";
  }
  
  return "I'm here to help you search through your saved content. Try asking me a specific question about something you've saved!";
}

/**
 * Process and index content for RAG
 * Called when user saves new content
 */
export async function indexContent(
  userId: string,
  contentId: string,
  title: string,
  link: string,
  text: string
) {
  try {
    // Extract full content from the URL (pass userId for rate limiting)
    let extractedContent = await extractContentFromUrl(link, userId);
    
    // Use provided text as fallback if URL extraction failed or content too short
    if (!extractedContent || extractedContent.length < 50) {
      extractedContent = text || '';
    }
    
    // Create rich content combining title, link, and extracted content
    const fullText = createRichContent(title, link, extractedContent);

    // Split into chunks
    const chunks = chunkText(fullText, 500);

    // Create embeddings for all chunks
    const embeddings = await createEmbeddings(chunks);

    if (embeddings.length === 0 || embeddings.length !== chunks.length) {
      throw new Error("Failed to generate embeddings for all chunks");
    }

    // Prepare chunks with embeddings
    const chunksWithEmbeddings = chunks.map((text, idx) => {
      const embedding = embeddings[idx];
      if (!embedding) {
        throw new Error(`Missing embedding for chunk ${idx}`);
      }
      return {
        text,
        embedding,
      };
    });

    // Upsert to VectorDB
    await upsertChunks(userId, contentId, chunksWithEmbeddings);
  } catch (error) {
    console.error("Error indexing content:", error);
    throw new Error("Failed to index content for RAG");
  }
}

/**
 * Main RAG pipeline
 * User asks question → search → retrieve → generate answer
 * Industry-standard optimization: Skip DB search for basic greetings/small talk
 */
export async function answerQuestion(
  userId: string,
  question: string
): Promise<{
  answer: string;
  sources: Array<{
    contentId: string;
    text: string;
    score: number;
  }>;
  title: string;
  matchedContentIds: string[];
}> {
  try {
    // OPTIMIZATION: Check if question needs database search
    // Skip expensive vector search for greetings and small talk
    if (!requiresDatabaseSearch(question)) {
      return {
        answer: generateBasicResponse(question),
        sources: [],
        title: question.substring(0, 50),
        matchedContentIds: [],
      };
    }

    // 1. Create embedding for question
    const questionEmbedding = await createEmbedding(question);

    // 2. Search VectorDB with intelligent fetching
    // Start with fewer results; fetch more only if needed to reach 5 unique posts
    let searchResults = await searchChunks(userId, questionEmbedding, 10);
    
    // If we got fewer than 5 unique posts, fetch more
    if (new Set(searchResults.map(r => r.contentId)).size < 5) {
      const additionalResults = await searchChunks(userId, questionEmbedding, 20);
      searchResults = additionalResults; // Use the full batch
    }

    if (searchResults.length === 0) {
      return {
        answer:
          "I couldn't find any relevant content in your saved items to answer this question. Try saving more content related to your query.",
        sources: [],
        title: await generateChatTitle(question),
        matchedContentIds: [],
      };
    }

    // 3. Group by contentId and get top chunk from each post
    const postMap = new Map<string, typeof searchResults[0]>();

    for (const result of searchResults) {
      if (!postMap.has(result.contentId)) {
        postMap.set(result.contentId, result);
      }
      // Stop when we have 5 unique posts
      if (postMap.size >= 5) break;
    }

    const uniquePosts = Array.from(postMap.values());

    // 4. Prepare context for LLM
    const contextForLLM = uniquePosts.map((result) => {
      const title = extractTitleFromText(result.text) || "Saved post";
      const dashboardLink = buildDashboardLink(result.contentId);
      const cleanedText = result.text
        .replace(/^Title:\s*.+$/m, "")
        .replace(/^Link:\s*.+$/m, "")
        .trim();
      return {
        text: cleanedText,
        contentId: result.contentId,
        score: result.score,
        title,
        dashboardLink,
      };
    });

    // 5. Generate answer using LLM with retrieved context
    const answer = await generateAnswer(question, contextForLLM);

    // 6. Generate chat title
    const title = await generateChatTitle(question);

    return {
      answer,
      sources: contextForLLM,
      title,
      matchedContentIds: contextForLLM.map((item) => item.contentId),
    };
  } catch (error) {
    console.error("Error in RAG pipeline:", error);
    throw new Error("Failed to process question");
  }
}

/**
 * Remove indexed content from VectorDB
 */
export async function unindexContent(contentId: string) {
  try {
    await deleteChunksForContent(contentId);
  } catch (error) {
    console.error("Error unindexing content:", error);
    throw new Error("Failed to remove content from RAG");
  }
}
