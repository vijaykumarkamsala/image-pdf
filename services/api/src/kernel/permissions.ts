import type { EffectivePermission, Permission, RolePreset } from "ipw-contracts-ts/product";

const ALL_PERMISSIONS: Permission[] = [
  "workspace.read",
  "project.create",
  "project.read",
  "file.create",
  "file.read",
  "file.move",
  "audit.read",
  "usage.read",
];

const ROLE_PERMISSIONS: Record<RolePreset, ReadonlySet<Permission>> = {
  owner: new Set(ALL_PERMISSIONS),
  admin: new Set(ALL_PERMISSIONS),
  member: new Set([
    "workspace.read",
    "project.create",
    "project.read",
    "file.create",
    "file.read",
    "file.move",
  ]),
  viewer: new Set(["workspace.read", "project.read", "file.read"]),
};

export function permissionsForRole(role: RolePreset): EffectivePermission[] {
  const allowed = ROLE_PERMISSIONS[role];
  return ALL_PERMISSIONS.map((permission) => ({
    schema_version: "1.7.0",
    permission,
    allowed: allowed.has(permission),
    origin: "role",
    role,
    grant_id: null,
  }));
}

export function hasPermission(effective: EffectivePermission[], permission: Permission): boolean {
  return effective.some((item) => item.permission === permission && item.allowed);
}
