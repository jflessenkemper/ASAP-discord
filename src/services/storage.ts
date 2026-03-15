import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';

const storage = new Storage({
  projectId: process.env.GCS_PROJECT_ID,
});

const bucketName = process.env.GCS_BUCKET_NAME || 'asap-evidence';

export async function uploadEvidence(
  jobId: string,
  fileBuffer: Buffer,
  mimeType: string,
  originalName: string
): Promise<string> {
  const ext = originalName.split('.').pop() || 'bin';
  const fileName = `jobs/${jobId}/${uuidv4()}.${ext}`;
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(fileName);

  await file.save(fileBuffer, {
    metadata: { contentType: mimeType },
  });

  // Make publicly readable (or use signed URLs in production)
  await file.makePublic();

  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}
