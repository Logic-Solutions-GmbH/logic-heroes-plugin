/**
 * add-service-collaborator — add one or more operational collaborators on a service.
 *
 * Each `--tenant-key` is one `POST /services/:serviceId/collaborators` with body
 * `{ "collaboratorTenantKey": "<key>" }`. 201 means added; 200 means the same
 * collaboration was already active.
 *
 * Usage:
 *   npx tsx add-service-collaborator.ts <service-id> --tenant-key <key> \
 *       [--tenant-key <key> ...]
 *
 * Example:
 *   npx tsx add-service-collaborator.ts 11111111-1111-4111-8111-111111111111 \
 *       --tenant-key example-collaborator
 */
import {
  run,
  parseArgs,
  flagValues,
  requireApiKey,
  addServiceCollaborator,
  heading,
  kv,
} from './lib';

run(async (config) => {
  const argv = process.argv.slice(2);
  const { positional } = parseArgs(argv);
  const serviceId = positional[0];
  const tenantKeys = flagValues(argv, 'tenant-key').map((key) => key.trim());

  if (!serviceId || tenantKeys.length === 0 || tenantKeys.some((key) => !key)) {
    throw new Error(
      'Usage: npx tsx add-service-collaborator.ts <service-id> --tenant-key <key> ' +
        '[--tenant-key <key> ...]',
    );
  }

  const apiKey = requireApiKey(config);
  heading('Adding service collaborators');
  kv('serviceId', serviceId);

  for (const tenantKey of tenantKeys) {
    const result = await addServiceCollaborator(config, { serviceId, apiKey, tenantKey });
    kv('tenantKey', result.tenantKey);
    kv('collaboratorId', result.id);
    kv('created', result.created);
  }
});
