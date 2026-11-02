/**
 * @openzhiyu/rag - RAG pipeline utilities: chunking, embeddings, and vector stores.
 */

export {
  chunkText,
  countTokens,
  getOptimalChunkSize,
  estimateChunkCount,
} from "./chunking";
export type { ChunkOptions, TextChunk } from "./chunking";

export {
  generateEmbedding,
  generateEmbeddings,
  cosineSimilarity,
  getEmbeddingDimensions,
  getEmbeddingModel,
  getModelPricing,
} from "./embeddings";
export type { EmbeddingResult } from "./embeddings";

export {
  getVectorStore,
  addDocumentToVectorStore,
  searchVectorStore,
  deleteDocumentFromVectorStore,
  getVectorStoreStats,
  getVectorStoreCapabilities,
  FALLBACK_VECTOR_STORE_CAPABILITIES,
  configureVectorService,
  type IVectorStore,
  type SearchResult,
  type VectorStoreBackend,
  type VectorStoreCapabilities,
  type VectorSearchFilter,
  type VectorStoreSearchOptions,
  type VectorStoreStats,
} from "./vector-service";

export {
  UnifiedVectorSearchService,
  createVectorStore,
  type RawMessageWithEmbedding,
  type UnifiedVectorSearchResult,
  type UnifiedVectorSearchServiceOptions,
  type UnifiedVectorSearchStats,
  type VectorSearchByVectorOptions,
  type VectorSearchOptions,
  type VectorStoreConfig,
} from "./unified-vector-search-service";

export { UniversalEmbeddings } from "./universal-embeddings";
export {
  CloudEmbeddingProvider,
  getCloudEmbeddingConfiguration,
  getConfiguredEmbeddingDimensions,
  resolveEmbeddingApiFormat,
  getConfiguredEmbeddingModelName,
  getConfiguredEmbeddingProvider,
  getEmbeddingProviderType,
  type CloudEmbeddingProviderOptions,
  type EmbeddingProvider,
  type EmbeddingProviderFactoryOptions,
  type EmbeddingProviderType,
} from "./embedding-provider";
export {
  LocalTransformersEmbeddingProvider,
  type LocalTransformersEmbeddingProviderOptions,
} from "./local-transformers-embedding-provider";

export {
  TextLoader,
  AppleDocumentLoader,
  parseFile,
  parseFileToDocument,
  getPdfPageCount,
  shouldUseNativePdf,
  estimateChunkCount as ragEstimateChunkCount,
  isSupportedContentType,
  configureParsers,
  type FileContent,
  type ParsersConfig,
} from "./parsers";

export {
  SQLiteVecStore,
  getSQLiteVecStore,
  resetSQLiteVecStore,
  type VectorSearchResult,
  type DocumentChunk,
  type SQLiteVecStoreOptions,
  type SchemaModule,
} from "./sqlite-vec-store";

export {
  ChromaVectorStore,
  getChromaVectorStore,
  resetChromaVectorStore,
} from "./chroma-store";

export {
  PG_VECTOR_STORE_CAPABILITIES,
  getPGVectorCapabilities,
  getPGVectorStore,
  processDocumentWithPGVector,
  searchWithPGVector,
  deleteDocumentsFromPGVector,
  getDocumentCount,
  listUserDocuments,
  configurePGVector,
} from "./pgvector-store";
