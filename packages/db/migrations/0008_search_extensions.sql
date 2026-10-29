-- pg_trgm gives search its trigram indexes and word_similarity (ADR 0013). "if not exists" makes
-- this safe on a database that already has data or already has the extension. pg_trgm is a
-- trusted extension, so the database owner can create it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
