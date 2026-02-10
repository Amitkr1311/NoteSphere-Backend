import { createEmbedding, createEmbeddings, chunkText } from "./embeddingService.ts";
import {
  upsertChunks,
  searchChunks,
  deleteChunksForContent,
} from "./vectordbService.ts";
import { generateAnswer, generateChatTitle } from "./llmService.ts";
import { extractContentFromUrl, createRichContent } from "./contentExtractor.ts";

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
    console.log(`📄 Processing content: ${title}`);
    console.log(`🔗 Extracting content from: ${link}`);
    
    // Extract full content from the URL (pass userId for rate limiting)
    let extractedContent = await extractContentFromUrl(link, userId);
    
    // Use provided text as fallback if URL extraction failed or content too short
    if (!extractedContent || extractedContent.length < 50) {
      extractedContent = text || '';
    }
    
    // Create rich content combining title, link, and extracted content
    const fullText = createRichContent(title, link, extractedContent);
    
    if (extractedContent && extractedContent.length > 50) {
      console.log(`✅ Extracted ${extractedContent.length} characters from ${text ? 'provided text' : 'URL'}`);
    } else {
      console.log(`⚠️  Content extraction failed or content too short, using title only`);
    }

    // Split into chunks
    const chunks = chunkText(fullText, 500);
    console.log(`📦 Created ${chunks.length} chunks`);

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

    console.log(`✅ Content indexed successfully`);
  } catch (error) {
    console.error("Error indexing content:", error);
    throw new Error("Failed to index content for RAG");
  }
}

/**
 * Main RAG pipeline
 * User asks question → search → retrieve → generate answer
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
}> {
  try {
    console.log(`💬 Processing question: ${question}`);

    // 1. Create embedding for question
    const questionEmbedding = await createEmbedding(question);

    // 2. Search VectorDB with intelligent fetching
    // Start with fewer results; fetch more only if needed to reach 5 unique posts
    let searchResults = await searchChunks(userId, questionEmbedding, 10);
    
    // If we got fewer than 5 unique posts, fetch more
    if (new Set(searchResults.map(r => r.contentId)).size < 5) {
      console.log('⚡ Need more results to reach 5 unique posts, fetching additional chunks...');
      const additionalResults = await searchChunks(userId, questionEmbedding, 20);
      searchResults = additionalResults; // Use the full batch
    }

    if (searchResults.length === 0) {
      return {
        answer:
          "I couldn't find any relevant content in your saved items to answer this question. Try saving more content related to your query.",
        sources: [],
        title: await generateChatTitle(question),
      };
    }

    console.log(`🔍 Found ${searchResults.length} relevant chunks`);

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
    console.log(`📊 Found ${uniquePosts.length} unique posts`);

    // 4. Prepare context for LLM
    const contextForLLM = uniquePosts.map((result) => ({
      text: result.text,
      contentId: result.contentId,
      score: result.score,
    }));

    // 5. Generate answer using LLM with retrieved context
    const answer = await generateAnswer(question, contextForLLM);

    // 6. Generate chat title
    const title = await generateChatTitle(question);

    return {
      answer,
      sources: contextForLLM,
      title,
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
    console.log(`🗑️  Content removed from VectorDB: ${contentId}`);
  } catch (error) {
    console.error("Error unindexing content:", error);
    throw new Error("Failed to remove content from RAG");
  }
}
