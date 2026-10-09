import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";

const ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), "storage");

export type PutResult = {
  backend: "local" | "s3";
  path: string;
  contentType: string;
};

function backend(): "local" | "s3" {
  return process.env.STORAGE_BACKEND === "s3" ? "s3" : "local";
}

function s3ClientConfig() {
  const region = process.env.S3_REGION || "us-east-1";
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY required when STORAGE_BACKEND=s3");
  }
  return {
    region,
    endpoint,
    forcePathStyle: Boolean(endpoint),
    credentials: { accessKeyId, secretAccessKey },
  };
}

export async function putObject(relPath: string, data: Buffer | string, contentType?: string): Promise<PutResult> {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const type = contentType || "application/octet-stream";

  if (backend() === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("S3_BUCKET required");
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client(s3ClientConfig());
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: relPath,
        Body: body,
        ContentType: type,
      }),
    );
    return { backend: "s3", path: relPath, contentType: type };
  }

  const abs = path.join(/*turbopackIgnore: true*/ ROOT, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
  return { backend: "local", path: relPath, contentType: type };
}

export async function getObject(relPath: string): Promise<Buffer> {
  if (backend() === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("S3_BUCKET required");
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client(s3ClientConfig());
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: relPath }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Empty S3 object");
    return Buffer.from(bytes);
  }
  return readFile(path.join(/*turbopackIgnore: true*/ ROOT, relPath));
}

export async function deleteObject(relPath: string): Promise<void> {
  if (backend() === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("S3_BUCKET required");
    const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client(s3ClientConfig());
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: relPath }));
    return;
  }
  const { unlink } = await import("fs/promises");
  try {
    await unlink(path.join(/*turbopackIgnore: true*/ ROOT, relPath));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
}

export async function getSignedDownloadUrl(relPath: string, expiresIn = 900): Promise<string | null> {
  if (backend() !== "s3") return null;
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET required");
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new S3Client(s3ClientConfig());
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: relPath }), { expiresIn });
}

export async function storageHealth(): Promise<{ ok: boolean; backend: string; detail?: string }> {
  try {
    if (backend() === "s3") {
      const bucket = process.env.S3_BUCKET;
      if (!bucket) return { ok: false, backend: "s3", detail: "S3_BUCKET missing" };
      const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client(s3ClientConfig());
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { ok: true, backend: "s3" };
    }
    await mkdir(path.join(/*turbopackIgnore: true*/ ROOT), { recursive: true });
    return { ok: true, backend: "local" };
  } catch (e) {
    return { ok: false, backend: backend(), detail: e instanceof Error ? e.message : "storage error" };
  }
}

export function storageRoot() {
  return ROOT;
}

export function checksum(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}
