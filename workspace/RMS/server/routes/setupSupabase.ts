import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSupabaseProvisioningStatus, listSupabaseProjects, startSupabaseProvisioning } from '../provisioning/supabase';

async function readJsonBody(req: IncomingMessage) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleSupabaseSetupRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';

  if (req.method === 'POST' && url === '/api/setup/supabase/projects') {
    try {
      const payload = await readJsonBody(req);
      const projects = await listSupabaseProjects(payload as never);
      writeJson(res, 200, { projects });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : 'Failed to list projects.' });
    }
    return true;
  }

  if (req.method === 'POST' && url === '/api/setup/supabase') {
    try {
      const payload = await readJsonBody(req);
      const started = startSupabaseProvisioning(payload as never);
      writeJson(res, 202, started);
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
    }
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/api/setup/supabase/')) {
    const operationId = url.replace('/api/setup/supabase/', '').trim();
    if (!operationId) {
      writeJson(res, 400, { error: 'Missing operation id.' });
      return true;
    }

    const status = getSupabaseProvisioningStatus(operationId);
    if (!status) {
      writeJson(res, 404, { error: 'Provisioning operation not found.' });
      return true;
    }

    writeJson(res, 200, status);
    return true;
  }

  return false;
}
