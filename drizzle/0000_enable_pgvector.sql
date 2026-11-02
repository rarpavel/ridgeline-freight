-- Custom migration: runs before the tables so chunks.embedding can use the vector type.
CREATE EXTENSION IF NOT EXISTS vector;
