export type QuotedTaskContract = {
  title: string;
  estimateLowRwf: bigint;
  estimateHighRwf: bigint;
  maxRwf: bigint;
  assumptions: string[];
  idempotencyKey: string;
};

export function validateQuotedTaskContract(input: QuotedTaskContract): void {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new Error("Task title must contain 1 to 200 characters");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new Error("idempotencyKey must contain 1 to 200 characters");
  if (input.estimateLowRwf <= 0n || input.estimateLowRwf > input.estimateHighRwf || input.estimateHighRwf > input.maxRwf) {
    throw new Error("Quote must satisfy 0 < low estimate <= high estimate <= maximum RWF");
  }
  if (input.maxRwf > 1_000_000_000n) throw new Error("Quoted maximum exceeds the platform limit");
  if (input.assumptions.length > 20 || input.assumptions.some((assumption) => !assumption.trim() || assumption.length > 500)) {
    throw new Error("Quote assumptions are invalid");
  }
}

export function quoteReplayMatches(
  input: Pick<QuotedTaskContract, "title" | "estimateLowRwf" | "estimateHighRwf" | "maxRwf"> & { kind: string; quality: string },
  existing: typeof input,
): boolean {
  return input.title === existing.title
    && input.kind === existing.kind
    && input.quality === existing.quality
    && input.estimateLowRwf === existing.estimateLowRwf
    && input.estimateHighRwf === existing.estimateHighRwf
    && input.maxRwf === existing.maxRwf;
}
