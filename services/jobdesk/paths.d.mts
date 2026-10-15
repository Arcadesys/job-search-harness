type Platform = NodeJS.Platform;
type Env = Record<string, string | undefined>;

export const APP_NAME: string;
export function legacyRoots(options?: { platform?: Platform; home?: string }): string[];
export function defaultDataRoot(options?: {
  platform?: Platform;
  env?: Env;
  home?: string;
  exists?: (candidate: string) => boolean;
}): string;
export function brokerEndpoint(root: string, options?: { platform?: Platform }): string;
export function clientEndpoint(options?: { platform?: Platform; env?: Env }): string;
export function browserCommand(url: string, platform?: Platform): [string, string[]];
export function isMainModule(moduleURL: string, entry?: string): boolean;
