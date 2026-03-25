import { GoogleAuth } from 'google-auth-library';

const PROJECT_ID = process.env.GCS_PROJECT_ID || 'asap-489910';
const REGION = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
const SERVICE_NAME = process.env.CLOUD_RUN_SERVICE || 'asap';

const BASE_URL = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}`;
const REVISIONS_URL = `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/revisions`;

let auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!auth) {
    auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  }
  return auth;
}

interface RevisionInfo {
  name: string;
  uid: string;
  createTime: string;
  image: string;
}

/**
 * List recent Cloud Run revisions (newest first).
 */
export async function listRevisions(limit = 5): Promise<RevisionInfo[]> {
  const client = await getAuth().getClient();
  const res = await client.request({
    url: `${REVISIONS_URL}?pageSize=${limit}`,
    method: 'GET',
  });

  const data = res.data as any;
  const revisions = (data.revisions || []) as any[];

  return revisions.map((r: any) => ({
    name: r.name?.split('/').pop() || r.uid,
    uid: r.uid,
    createTime: r.createTime,
    image: r.template?.containers?.[0]?.image || 'unknown',
  }));
}

/**
 * Rollback to a specific revision by routing 100% traffic to it.
 */
export async function rollbackToRevision(revisionName: string): Promise<string> {
  const client = await getAuth().getClient();

  // Get the current service config
  const serviceRes = await client.request({
    url: BASE_URL,
    method: 'GET',
  });

  const service = serviceRes.data as any;

  // Set traffic to target revision only
  service.traffic = [
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: revisionName,
      percent: 100,
    },
  ];

  await client.request({
    url: BASE_URL,
    method: 'PATCH',
    body: JSON.stringify(service),
    headers: { 'Content-Type': 'application/json' },
  });

  return `✅ Traffic routed to revision \`${revisionName}\`. Rollback complete.`;
}

/**
 * Get the currently active revision name.
 */
export async function getCurrentRevision(): Promise<string> {
  const client = await getAuth().getClient();
  const res = await client.request({
    url: BASE_URL,
    method: 'GET',
  });

  const data = res.data as any;
  const traffic = data.traffic || [];
  const active = traffic.find((t: any) => t.percent === 100);
  return active?.revision || 'unknown';
}
