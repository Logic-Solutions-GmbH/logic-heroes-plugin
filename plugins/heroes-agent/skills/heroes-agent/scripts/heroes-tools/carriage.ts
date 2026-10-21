import { existsSync, readFileSync } from 'node:fs';

export const TRANSPORT_SERVICE_KEYS: ReadonlySet<string> = new Set([
  'oceanfreight',
  'airfreight',
  'inland_transport',
]);

const CONTAINER_ALLOCATIONS = ['exclusive', 'shared', 'none'] as const;
const VEHICLE_TYPES = ['vessel', 'barge', 'truck', 'train', 'plane'] as const;
const VEHICLE_ALLOCATIONS = ['exclusive', 'shared'] as const;
const HANDLING_METHODS = ['lift_on_lift_off', 'roll_on_roll_off'] as const;
const WATER_VEHICLE_TYPES: ReadonlySet<string> = new Set(['vessel', 'barge']);

export interface Carriage {
  [key: string]: unknown;
  containerAllocation?: (typeof CONTAINER_ALLOCATIONS)[number];
  vehicleType: (typeof VEHICLE_TYPES)[number];
  vehicleAllocation: (typeof VEHICLE_ALLOCATIONS)[number];
  handlingMethod?: (typeof HANDLING_METHODS)[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function vocabularyIssue(at: string, value: unknown, values: readonly string[]): string {
  return `${at} must be one of: ${values.join(', ')} (received ${JSON.stringify(value)})`;
}

/**
 * Validate the four service_carriage columns and their database constraints.
 * Heroes does not publish these vocabularies in a catalog yet, so this is the
 * one deliberately hard-coded closed vocabulary in the plugin.
 */
export function parseCarriage(
  value: unknown,
  at = 'carriage',
): { carriage?: Carriage; issues: string[] } {
  if (!isRecord(value)) return { issues: [`${at} must be a JSON object`] };

  const issues: string[] = [];
  const containerAllocation = value.containerAllocation;
  const vehicleType = value.vehicleType;
  const vehicleAllocation = value.vehicleAllocation;
  const handlingMethod = value.handlingMethod;

  if (
    containerAllocation !== undefined &&
    containerAllocation !== null &&
    !oneOf(containerAllocation, CONTAINER_ALLOCATIONS)
  ) {
    issues.push(vocabularyIssue(`${at}.containerAllocation`, containerAllocation, CONTAINER_ALLOCATIONS));
  }
  if (!oneOf(vehicleType, VEHICLE_TYPES)) {
    issues.push(vocabularyIssue(`${at}.vehicleType`, vehicleType, VEHICLE_TYPES));
  }
  if (!oneOf(vehicleAllocation, VEHICLE_ALLOCATIONS)) {
    issues.push(vocabularyIssue(`${at}.vehicleAllocation`, vehicleAllocation, VEHICLE_ALLOCATIONS));
  }
  if (
    handlingMethod !== undefined &&
    handlingMethod !== null &&
    !oneOf(handlingMethod, HANDLING_METHODS)
  ) {
    issues.push(vocabularyIssue(`${at}.handlingMethod`, handlingMethod, HANDLING_METHODS));
  }

  if (oneOf(vehicleType, VEHICLE_TYPES)) {
    const hasContainerAllocation = oneOf(containerAllocation, CONTAINER_ALLOCATIONS);
    if (vehicleType === 'plane' && hasContainerAllocation) {
      issues.push(`${at}.containerAllocation must be omitted when vehicleType is plane`);
    }
    if (vehicleType !== 'plane' && !hasContainerAllocation) {
      issues.push(`${at}.containerAllocation is required when vehicleType is ${vehicleType}`);
    }

    const onWater = WATER_VEHICLE_TYPES.has(vehicleType);
    const hasHandlingMethod = oneOf(handlingMethod, HANDLING_METHODS);
    if (onWater && !hasHandlingMethod) {
      issues.push(`${at}.handlingMethod is required when vehicleType is ${vehicleType}`);
    }
    if (!onWater && hasHandlingMethod) {
      issues.push(`${at}.handlingMethod must be omitted when vehicleType is ${vehicleType}`);
    }
  }

  if (issues.length > 0) return { issues };
  const carriage = {
    ...value,
    vehicleType: vehicleType as Carriage['vehicleType'],
    vehicleAllocation: vehicleAllocation as Carriage['vehicleAllocation'],
  } as Carriage;
  if (containerAllocation === undefined || containerAllocation === null) {
    delete carriage.containerAllocation;
  }
  if (handlingMethod === undefined || handlingMethod === null) {
    delete carriage.handlingMethod;
  }
  return {
    carriage,
    issues: [],
  };
}

export function parseServiceCarriage(
  serviceKey: string,
  value: unknown,
  at = 'carriage',
): { carriage?: Carriage; issues: string[] } {
  const parsed = parseCarriage(value, at);
  const issues = [...parsed.issues];
  if (!TRANSPORT_SERVICE_KEYS.has(serviceKey)) {
    issues.unshift(
      `${at} is not allowed on serviceKey "${serviceKey}"; only oceanfreight, airfreight, and inland_transport carry it`,
    );
  }
  return issues.length > 0 ? { issues } : parsed;
}

/** Read a CLI carriage argument from a file; no business value enters shell text. */
export function readCarriageFile(path: string, serviceKey: string): Carriage {
  if (!existsSync(path)) throw new Error(`carriage file not found: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`carriage file is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = parseServiceCarriage(serviceKey, value);
  if (!parsed.carriage) throw new Error(parsed.issues.join('\n'));
  return parsed.carriage;
}
