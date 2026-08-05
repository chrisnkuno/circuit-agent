export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

export type Permission =
  | "task:create"
  | "task:read"
  | "task:cancel"
  | "agent:run"
  | "approval:decide"
  | "connector:manage"
  | "skill:manage"
  | "billing:manage"
  | "organization:manage";

const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>(["task:create", "task:read", "task:cancel", "agent:run", "approval:decide", "connector:manage", "skill:manage", "billing:manage", "organization:manage"]),
  admin: new Set<Permission>(["task:create", "task:read", "task:cancel", "agent:run", "approval:decide", "connector:manage", "skill:manage"]),
  member: new Set<Permission>(["task:create", "task:read", "task:cancel", "agent:run"]),
  viewer: new Set<Permission>(["task:read"]),
};

export function hasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function requirePermission(role: OrganizationRole, permission: Permission): void {
  if (!hasPermission(role, permission)) throw new Error(`Role ${role} cannot perform ${permission}`);
}

export function requireSameOrganization(resourceOrganizationId: string, actorOrganizationId: string): void {
  if (resourceOrganizationId !== actorOrganizationId) throw new Error("Cross-organization access denied");
}
