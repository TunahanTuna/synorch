import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  blobRefSchema,
  digestSchema,
  sha256,
  StoreFailure,
  type BlobRef,
  type BlobStore,
  type Digest,
} from "../contracts/index.ts";
import { errnoCode, isMissing, PRIVATE_DIRECTORY_MODE, writeFileDurably } from "./durable-file.ts";
import { blobPath } from "./layout.ts";

/** Creates the content-addressed blob store under `<home>/blobs/sha256/<2 hex>/<62 hex>`. */
export function createBlobStore(home: string): BlobStore {
  return new FileBlobStore(path.resolve(home));
}

class FileBlobStore implements BlobStore {
  readonly #home: string;

  public constructor(home: string) {
    this.#home = home;
  }

  public async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const digest = sha256(bytes);
    const parsed = blobRefSchema.safeParse({ digest, size_bytes: bytes.byteLength, media_type: mediaType });
    if (!parsed.success) throw new StoreFailure("write_failed", `invalid blob media type: ${JSON.stringify(mediaType)}`);
    const target = blobPath(this.#home, digest);
    if (await holdsDigest(target, digest)) return parsed.data;
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await writeFileDurably(target, bytes);
    } catch (error: unknown) {
      if (await holdsDigest(target, digest)) return parsed.data;
      throw new StoreFailure("write_failed", `blob ${digest} could not be written: ${errnoCode(error) ?? String(error)}`);
    }
    return parsed.data;
  }

  public async get(digest: Digest): Promise<Uint8Array> {
    if (!digestSchema.safeParse(digest).success) throw new StoreFailure("blob_missing", `not a runtime digest: ${String(digest)}`);
    let bytes: Buffer;
    try {
      bytes = await readFile(blobPath(this.#home, digest));
    } catch (error: unknown) {
      if (isMissing(error)) throw new StoreFailure("blob_missing", `blob ${digest} is not in the store`);
      throw new StoreFailure("blob_missing", `blob ${digest} could not be read: ${errnoCode(error) ?? String(error)}`);
    }
    if (sha256(bytes) !== digest) throw new StoreFailure("blob_digest_mismatch", `blob ${digest} failed digest verification`);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  public async has(digest: Digest): Promise<boolean> {
    if (!digestSchema.safeParse(digest).success) return false;
    try {
      return (await stat(blobPath(this.#home, digest))).isFile();
    } catch (error: unknown) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

/** Streams the existing file through sha256 so a damaged copy is rewritten instead of trusted. */
async function holdsDigest(file: string, digest: Digest): Promise<boolean> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
  return `sha256:${hash.digest("hex")}` === digest;
}
