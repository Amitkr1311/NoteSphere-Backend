import { Pinecone } from "@pinecone-database/pinecone";

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY || "",
});

const INDEX_NAME = process.env.PINECONE_INDEX_NAME || "brainly";

/**
 * Get Pinecone index
 */
async function getIndex() {
  return pinecone.Index(INDEX_NAME);
}

/**
 * Upsert vectors to Pinecone
 * Stores chunks with their embeddings and metadata
 */
export async function upsertChunks(
  userId: string,
  contentId: string,
  chunks: { text: string; embedding: number[] }[]
) {
  try {
    const index = await getIndex();

    const vectors = chunks.map((chunk, idx) => ({
      id: `${contentId}-chunk-${idx}`,
      values: chunk.embedding,
      metadata: {
        userId,
        contentId,
        text: chunk.text,
        chunkIndex: idx,
      },
    }));

    await index.upsert({ records: vectors });
    console.log(`✅ Upserted ${vectors.length} chunks for content ${contentId}`);
  } catch (error) {
    console.error("Error upserting chunks:", error);
    throw new Error("Failed to upsert chunks to VectorDB");
  }
}

/**
 * Search VectorDB for similar content
 * Returns top N matching chunks
 */
export async function searchChunks(
  userId: string,
  queryEmbedding: number[],
  topK: number = 5
): Promise<
  Array<{
    id: string;
    score: number;
    contentId: string;
    text: string;
    chunkIndex: number;
  }>
> {
  try {
    const index = await getIndex();

    const results = await index.query({
      vector: queryEmbedding,
      topK,
      filter: {
        userId: { $eq: userId }, // Only search user's content
      },
      includeMetadata: true,
    });

    return results.matches.map((match:any) => ({
      id: match.id,
      score: match.score,
      contentId: match.metadata?.contentId as string,
      text: match.metadata?.text as string,
      chunkIndex: match.metadata?.chunkIndex as number,
    }));
  } catch (error) {
    console.error("Error searching chunks:", error);
    throw new Error("Failed to search VectorDB");
  }
}

/**
 * Delete all chunks for a content
 * Called when content is deleted
 */
export async function deleteChunksForContent(contentId: string) {
  try {
    const index = await getIndex();

    await index.deleteMany({
      filter: {
        contentId: { $eq: contentId },
      },
    });

    console.log(`🗑️  Deleted chunks for content: ${contentId}`);
  } catch (error) {
    console.error("Error deleting chunks:", error);
    throw new Error("Failed to delete chunks from VectorDB");
  }
}

/**
 * Check if index exists, create if not
 */
export async function initializeVectorDB() {
  try {
    const indexes = await pinecone.listIndexes();
    const indexExists = indexes.indexes?.some((idx:any) => idx.name === INDEX_NAME);

    if (!indexExists) {
      console.log(`Creating index: ${INDEX_NAME}`);
      await pinecone.createIndex({
        name: INDEX_NAME,
        dimension: 384, // dimension for all-MiniLM-L6-v2
        metric: "cosine",
        spec: {
          serverless: {
            cloud: "aws",
            region: "us-east-1",
          },
        },
        waitUntilReady: true,
      });
      console.log(`✅ Index created: ${INDEX_NAME}`);
    } else {
      console.log(`✅ Index already exists: ${INDEX_NAME}`);
    }
  } catch (error) {
    console.error("Error initializing VectorDB:", error);
    throw new Error("Failed to initialize VectorDB");
  }
}
