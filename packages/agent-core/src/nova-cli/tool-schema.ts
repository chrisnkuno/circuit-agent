/**
 * One source of truth for what a tool accepts.
 *
 * Every tool used to declare its arguments twice: once as the JSON Schema the model is shown, and
 * again as hand-written checks inside `execute` — `requiredString(args.path)` beside a schema that
 * already said `path` was a required string. Two declarations of the same thing drift.
 *
 * Validating against the declared schema makes the schema authoritative, which buys three things
 * the scattered checks did not:
 *
 * - **Unknown parameters are refused.** Every schema declares `additionalProperties: false`, and
 *   nothing enforced it. A model inventing `write_file({ mode: "append" })` had the extra argument
 *   silently dropped and was told the write succeeded — which, as it asked for it, it had not.
 * - **One enforcement point instead of one per backend.** Type guards live in `LocalWorkspace` and
 *   again in `E2BWorkspace`; each new backend has to remember every one of them. Checking above
 *   the backend means a tool cannot reach *any* workspace with arguments of the wrong shape.
 * - **Nothing partially applied.** Arguments are checked before `execute` runs, so a call that is
 *   going to be rejected is rejected before it has done half its work.
 *
 * The supported subset is deliberately small — it is exactly what Nova's tools use, and a schema
 * feature nobody declares is a feature that cannot be tested. `assertSupportedSchema` fails loudly
 * on anything outside it rather than silently skipping validation, because a schema that quietly
 * validates nothing is worse than no validation at all.
 */

export type ScalarType = "string" | "integer" | "boolean";

export type PropertySchema =
  | { type: ScalarType; description?: string }
  | { type: "array"; items: { type: ScalarType }; description?: string };

export type ToolInputSchema = {
  type: "object";
  properties?: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties?: false;
};

/** Thrown for arguments a model can fix by reading the message. Surfaced to it as a tool error. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rejects a schema this validator cannot honour.
 *
 * Called for every tool at construction, so an unsupported schema is a startup failure rather than
 * a validation that silently passes everything at run time.
 */
export function assertSupportedSchema(toolName: string, schema: unknown): asserts schema is ToolInputSchema {
  if (!isPlainObject(schema)) throw new Error(`Tool ${toolName} has no input schema`);
  if (schema.type !== "object") throw new Error(`Tool ${toolName} input schema must be an object schema`);
  if (schema.additionalProperties !== false) throw new Error(`Tool ${toolName} input schema must set additionalProperties: false`);
  const properties = schema.properties ?? {};
  if (!isPlainObject(properties)) throw new Error(`Tool ${toolName} input schema properties must be an object`);
  for (const [name, property] of Object.entries(properties)) {
    if (!isPlainObject(property)) throw new Error(`Tool ${toolName} property ${name} must be a schema object`);
    const type = property.type;
    if (type === "array") {
      const items = property.items;
      if (!isPlainObject(items) || !["string", "integer", "boolean"].includes(items.type as string)) {
        throw new Error(`Tool ${toolName} property ${name} must declare scalar array items`);
      }
      continue;
    }
    if (!["string", "integer", "boolean"].includes(type as string)) {
      throw new Error(`Tool ${toolName} property ${name} has unsupported type ${String(type)}`);
    }
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) throw new Error(`Tool ${toolName} input schema required must be an array`);
  for (const name of required) {
    if (typeof name !== "string" || !(name in properties)) {
      throw new Error(`Tool ${toolName} requires ${String(name)}, which it does not declare`);
    }
  }
}

function checkScalar(type: ScalarType, value: unknown, label: string): void {
  if (type === "string") {
    if (typeof value !== "string") throw new ToolArgumentError(`${label} must be a string`);
    return;
  }
  if (type === "integer") {
    // `Number.isInteger` rejects NaN, Infinity and 1.5 together, which is the whole point: a
    // non-finite "integer" reaching a timeout or an offset is a hang or a crash, not a small error.
    if (!Number.isInteger(value)) throw new ToolArgumentError(`${label} must be an integer`);
    return;
  }
  if (typeof value !== "boolean") throw new ToolArgumentError(`${label} must be true or false`);
}

/**
 * Validates one tool call's arguments against its declared schema.
 *
 * Checks rather than coerces, with exactly one documented exception (a lone item where an array is
 * declared — see below). Coercion is how `"3"` becomes `3` in one place and stays a string in
 * another; a model that sent the wrong type is better told so, because it can fix that next turn.
 *
 * `null` for an absent optional value is accepted and dropped: models routinely send explicit
 * nulls for parameters they are not using, and rejecting that is a round trip spent on nothing.
 */
export function validateToolArguments(toolName: string, schema: ToolInputSchema, args: unknown): Record<string, unknown> {
  if (!isPlainObject(args)) throw new ToolArgumentError(`${toolName} arguments must be a JSON object`);
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) {
      const known = Object.keys(properties);
      throw new ToolArgumentError(
        `${toolName} has no parameter "${key}". It accepts: ${known.length > 0 ? known.join(", ") : "no parameters"}.`,
      );
    }
    // An explicit null means "not supplied" — but only where the schema agrees it is optional.
    if (value === undefined || value === null) {
      if (required.has(key)) throw new ToolArgumentError(`${toolName} requires ${key}`);
      continue;
    }
    if (property.type === "array") {
      // The one coercion this validator performs, and it earns its place: a model asked to close
      // one todo sends `complete: 2` rather than `complete: [2]` constantly, and the meaning is
      // unambiguous. Rejecting it costs a full round trip to relearn something nobody was confused
      // about. Anything other than a lone item of the declared type is still an error.
      const items = Array.isArray(value) ? value : [value];
      items.forEach((item, index) => checkScalar(property.items.type, item, `${toolName}.${key}[${index}]`));
      present[key] = items;
      continue;
    }
    checkScalar(property.type, value, `${toolName}.${key}`);
    present[key] = value;
  }

  for (const key of required) {
    if (!(key in present)) throw new ToolArgumentError(`${toolName} requires ${key}`);
  }
  return present;
}
