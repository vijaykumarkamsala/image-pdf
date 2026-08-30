export type FeatureFlag = "web-shell" | "api-shell" | "processing-worker-shell";

export interface FeatureFlags {
  enabled(flag: FeatureFlag): boolean;
}

export const recoveryOneFlags: FeatureFlags = {
  enabled(flag) {
    return flag === "web-shell";
  },
};
