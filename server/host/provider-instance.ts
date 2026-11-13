import { instanceConfigs, saveConfig, type AppConfig } from "../config.ts";
import { resetPathCache } from "../env-path.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { ProviderRegistry } from "../harness/registry.ts";

export async function persistInstance(deps: {
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "load" | "get" | "dispose">;
  clearAuthentication: (id: string) => void;
  detach: (id: string) => void;
  attach: (instance: ProviderInstance) => void;
}, instanceId: string, instances: NonNullable<AppConfig["instances"]>) {
  saveConfig({ instances }, { replaceInstances: true });
  deps.cfg.instances = instances;
  deps.clearAuthentication(instanceId);
  deps.detach(instanceId);
  if (Object.hasOwn(instances, instanceId)) {
    await deps.registry.load({ [instanceId]: instanceConfigs(deps.cfg)[instanceId] });
    const live = deps.registry.get(instanceId);
    if (live) deps.attach(live);
  } else {
    await deps.registry.dispose(instanceId);
  }
  resetPathCache();
}
