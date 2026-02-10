import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

let embeddingPipeline: FeatureExtractionPipeline | null = null;

/**
 * Initialize embedding pipeline (lazy load)
 * Uses Sentence Transformers for free embeddings
 */
async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    console.log("📚 Loading embedding model (first time takes ~30 seconds)...");
    embeddingPipeline = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
    console.log("✅ Embedding model loaded");
  }
  return embeddingPipeline;
}

/**
 * Create embeddings for text using free Sentence Transformers
 * Runs completely locally, no API calls
 */
export async function createEmbedding(text: string): Promise<number[]> {
  try {
    const pipe = await getEmbeddingPipeline();
    if (!pipe) {
      throw new Error("Embedding pipeline not initialized");
    }
    const result = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(result.data);
  } catch (error) {
    console.error("Error creating embedding:", error);
    throw new Error("Failed to create embedding");
  }
}

/**
 * Create embeddings for multiple texts
 * Processes all texts in parallel for better performance
 * Runs completely locally, no API calls
 */
export async function createEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    const pipe = await getEmbeddingPipeline();
    if (!pipe) {
      throw new Error("Embedding pipeline not initialized");
    }
    
    // Process all texts in parallel for better performance
    const embeddingPromises = texts.map((text) =>
      pipe(text, { pooling: "mean", normalize: true }).then((result) =>
        Array.from(result.data)
      )
    );
    
    const embeddings = await Promise.all(embeddingPromises);
    return embeddings;
  } catch (error) {
    console.error("Error creating embeddings:", error);
    throw new Error("Failed to create embeddings");
  }
}

/**
 * Split text into chunks for embedding
 * Each chunk should be meaningful (200-400 chars)
 */
export function chunkText(text: string, chunkSize: number = 500): string[] {
  if (!text || text.length === 0) return [];

  const chunks: string[] = [];
  let currentChunk = "";

  const sentences = text.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += (currentChunk ? " " : "") + sentence;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}
